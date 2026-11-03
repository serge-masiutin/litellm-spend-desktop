import Foundation

/// Темп суточного бюджета по показаниям ключа и текущему времени панели.
/// Окно — последний час по часам, а не по запросам: пауза честно снижает темп до нуля,
/// а не превращается в «мало данных». Тот же расчёт для Telegram и алертов — `forecastKey` в core/rules.ts.
struct DailyPace {
    /// Значения config.defaults.json — только для статуса от плагина без полей окна.
    static let defaultWindowMinutes: Double = 60
    /// Нижняя граница окна сразу после сброса, чтобы первые центы не давали сотни долларов в час.
    static let defaultMinWindowMinutes: Double = 10

    let now: Date
    let reset: Date
    let windowMinutes: Double
    let spend: Double
    let maxBudget: Double
    let ratePerHour: Double

    /// Параллельные ответы приходят не по порядку, и заголовок может нести старое показание.
    /// Расход ключа внутри периода не убывает, поэтому берём накопленный максимум.
    /// Показание ≤ 0 — сброс на шлюзе или аномалия: максимум считается заново.
    static func envelope(_ spends: [Double]) -> [Double] {
        var result: [Double] = []
        result.reserveCapacity(spends.count)
        for spend in spends {
            guard let previous = result.last, spend > 0 else { result.append(spend); continue }
            result.append(max(previous, spend))
        }
        return result
    }

    /// `points` — огибающая показаний текущего периода по возрастанию времени.
    init?(points: [SamplePoint], maxBudget: Double, periodStart: Date, reset: Date, now: Date,
          windowMinutes: Double = defaultWindowMinutes, minWindowMinutes: Double = defaultMinWindowMinutes) {
        guard now < reset, let last = points.last, last.spend >= 0 else { return nil }
        let restart = points.lastIndex { $0.spend <= 0 }
        let segment = restart.map { points[(points[$0].spend < 0 ? $0 + 1 : $0)...] } ?? points[...]
        let windowStart = max(now.addingTimeInterval(-windowMinutes * 60), periodStart)
        // До первого показания в окне запросов этого ключа отсюда не было: база — первое показание.
        let baseline = segment.last { $0.t <= windowStart }?.spend ?? segment.first!.spend
        let duration = max(now.timeIntervalSince(windowStart), minWindowMinutes * 60)
        self.now = now
        self.reset = reset
        self.windowMinutes = windowMinutes
        self.spend = last.spend
        self.maxBudget = maxBudget
        ratePerHour = max(0, last.spend - baseline) / (duration / 3600)
    }

    /// Как `paceWindow` в core/format.ts: «последний час» или «последние 30 мин».
    var windowLabel: String { windowMinutes == 60 ? "последний час" : "последние \(Fmt.duration(minutes: windowMinutes))" }
    var hoursToReset: Double { reset.timeIntervalSince(now) / 3600 }
    var projectedSpend: Double { spend + ratePerHour * hoursToReset }
    /// При таком темпе остаток закончится ровно к сбросу.
    var allowancePerHour: Double { max(0, maxBudget - spend) / hoursToReset }
    var exhaustsAt: Date? {
        guard projectedSpend > maxBudget else { return nil }
        guard ratePerHour > 0 else { return now }
        return now.addingTimeInterval(max(0, maxBudget - spend) / ratePerHour * 3600)
    }
}
