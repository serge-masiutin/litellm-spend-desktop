import AppKit
import SwiftUI

struct Verdict {
    let level: Level
    let symbol: String
    let headline: String
    let detail: String
}

private struct RawSample: Decodable {
    let t: Double
    let spend: Double
}

final class Monitor: ObservableObject {
    @Published var status: KeyStatus?
    @Published var planningBudget: PlanningBudget?
    @Published var points: [SamplePoint] = []
    @Published var sessions: [SessionInfo] = []
    @Published var alerts: [AlertInfo] = []
    @Published var settings = NotifySettings.default
    @Published var running: [String: Double] = [:]
    private var dismissedState = Dismissed.empty
    @Published var problems: [String] = []
    @Published var now = Date()

    let dir: URL
    let isDemo: Bool
    let config: URL

    init(dir: URL = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".local/share/opencode/litellm-spend"), isDemo: Bool = false, config: URL = AppEnvironment.current.config) {
        self.dir = dir
        self.isDemo = isDemo
        self.config = config
    }

    // MARK: чтение файлов

    private func read<T: Decodable>(_ type: T.Type, _ url: URL, _ problems: inout [String]) -> T? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        do {
            return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
        } catch {
            problems.append("\(url.lastPathComponent): \(error.localizedDescription)")
            return nil
        }
    }

    private func loadPoints(_ status: KeyStatus, _ problems: inout [String]) -> [SamplePoint] {
        if status.budget != nil {
            guard let samples = status.budgetSamples else {
                problems.append("status.json: нет точек локального бюджета")
                return []
            }
            // В ручном режиме точки начинаются с поправки: её снижение не является расходом.
            return samples.enumerated().map { SamplePoint(id: $0.offset, t: date($0.element.t), spend: $0.element.spend) }
        }
        let url = dir.appendingPathComponent("samples/\(String(format: "%.0f", status.periodStartAt)).jsonl")
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        let text: String
        do { text = try String(contentsOf: url, encoding: .utf8) } catch {
            problems.append("\(url.lastPathComponent): \(error.localizedDescription)")
            return []
        }
        var samples: [RawSample] = []
        for line in text.split(separator: "\n") {
            do { samples.append(try JSONDecoder().decode(RawSample.self, from: Data(line.utf8))) } catch {
                problems.append("\(url.lastPathComponent): \(error.localizedDescription)")
                break
            }
        }
        // Колебание расхода внутри периода не доказывает сброс на шлюзе.
        let sorted = samples.sorted { $0.t < $1.t }
        let current = zip(sorted, DailyPace.envelope(sorted.map(\.spend))).map { RawSample(t: $0.t, spend: $1) }
        let step = max(1, current.count / 200)
        // Показания ≤ 0 перезапускают огибающую, поэтому DailyPace должен видеть их и после прореживания.
        var picked = current.enumerated().filter { $0.offset % step == 0 || $0.element.spend <= 0 }.map(\.element)
        if let last = current.last, picked.last?.t != last.t { picked.append(last) }
        return picked.enumerated().map { SamplePoint(id: $0.offset, t: date($0.element.t), spend: $0.element.spend) }
    }

    func reload() {
        guard !isDemo else { return }
        var found: [String] = []
        do { planningBudget = try BudgetPlanSettings.readBudget(at: config) } catch {
            planningBudget = nil
            found.append("config.json: \(error.localizedDescription)")
        }
        let newStatus = read(KeyStatus.self, dir.appendingPathComponent("status.json"), &found)
        let newSettings = read(NotifySettings.self, dir.appendingPathComponent("settings.json"), &found) ?? .default

        var newSessions: [SessionInfo] = []
        let sessionsDir = dir.appendingPathComponent("sessions")
        let names = (try? FileManager.default.contentsOfDirectory(atPath: sessionsDir.path)) ?? []
        for name in names where name.hasSuffix(".json") {
            if let session = read(SessionInfo.self, sessionsDir.appendingPathComponent(name), &found), session.accountingVersion == 2 { newSessions.append(session) }
        }

        var newAlerts: [AlertInfo] = []
        if let text = try? String(contentsOf: dir.appendingPathComponent("alerts.jsonl"), encoding: .utf8) {
            for line in text.split(separator: "\n").suffix(30) {
                do { newAlerts.append(try JSONDecoder().decode(AlertInfo.self, from: Data(line.utf8))) } catch { found.append("alerts.jsonl: \(error.localizedDescription)") }
            }
        }

        var newRunning: [String: Double] = [:]
        let runningDir = dir.appendingPathComponent("running")
        for name in (try? FileManager.default.contentsOfDirectory(atPath: runningDir.path)) ?? [] where name.hasSuffix(".json") {
            if let mark = read(RunningMark.self, runningDir.appendingPathComponent(name), &found), mark.accountingVersion == 2 {
                newRunning[String(name.dropLast(".json".count))] = mark.at
            }
        }
        let newDismissed = read(Dismissed.self, dir.appendingPathComponent("dismissed.json"), &found) ?? .empty
        newAlerts = newAlerts.filter { $0.accountingVersion == 2 && $0.at > newDismissed.clearedBefore && !newDismissed.dismissed.contains($0.at) }

        status = newStatus
        running = newRunning
        dismissedState = newDismissed
        points = newStatus.map { loadPoints($0, &found) } ?? []
        settings = newSettings
        sessions = newSessions.sorted { $0.lastStepAt > $1.lastStepAt }
        alerts = newAlerts.sorted { $0.at > $1.at }
        problems = found
        now = Date()
    }

    func dismiss(_ alert: AlertInfo) {
        var updated = dismissedState
        updated.dismissed.append(alert.at)
        writeDismissed(updated)
    }

    func clearAlerts() {
        writeDismissed(Dismissed(clearedBefore: Date().timeIntervalSince1970 * 1000, dismissed: []))
    }

    private func writeDismissed(_ value: Dismissed) {
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let target = dir.appendingPathComponent("dismissed.json")
            let temp = dir.appendingPathComponent("dismissed.json.tmp")
            try JSONEncoder().encode(value).write(to: temp)
            _ = try FileManager.default.replaceItemAt(target, withItemAt: temp)
            reload()
        } catch {
            problems.append("dismissed.json: \(error.localizedDescription)")
        }
    }

    func save(_ updated: NotifySettings) throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let target = dir.appendingPathComponent("settings.json")
        let temp = dir.appendingPathComponent("settings.json.tmp")
        try JSONEncoder().encode(updated).write(to: temp)
        _ = try FileManager.default.replaceItemAt(target, withItemAt: temp)
        reload()
    }

    // MARK: производные величины

    var fraction: Double {
        guard let s = status else { return 0 }
        return min(1, max(0, s.spend / s.maxBudget))
    }

    var percent: Double? { status.flatMap { $0.spend < 0 || $0.budget?.isAvailable == false ? nil : $0.spend / $0.maxBudget * 100 } }
    var left: Double? { status.flatMap { $0.spend < 0 || $0.budget?.isAvailable == false ? nil : $0.maxBudget - $0.spend } }

    var resetIsPast: Bool { status.map { now >= date($0.nextResetAt) } ?? false }
    var minutesToReset: Double? { status.map { date($0.nextResetAt).timeIntervalSince(now) / 60 } }

    var dailyPace: DailyPace? {
        guard let s = status, s.spend >= 0, s.budget?.isAvailable != false else { return nil }
        return DailyPace(points: points, maxBudget: s.maxBudget, periodStart: date(s.periodStartAt), reset: date(s.nextResetAt), now: now,
                         windowMinutes: s.paceWindowMinutes ?? DailyPace.defaultWindowMinutes,
                         minWindowMinutes: s.paceMinWindowMinutes ?? DailyPace.defaultMinWindowMinutes)
    }

    /// Расход к моменту сброса при темпе последнего часа
    var projectedSpend: Double? { dailyPace?.projectedSpend }
    var projectedLeft: Double? { dailyPace.map { $0.maxBudget - $0.projectedSpend } }
    var forecastFraction: Double? { dailyPace.map { $0.projectedSpend / $0.maxBudget } }

    var verdict: Verdict {
        guard let s = status else {
            return Verdict(level: .idle, symbol: "questionmark.circle", headline: "Нет данных", detail: "Появятся после первого ответа модели в OpenCode")
        }
        if resetIsPast {
            return Verdict(level: .idle, symbol: "arrow.clockwise.circle", headline: "Начался новый период", detail: "Показания за него появятся после первого ответа модели")
        }
        if s.spend < 0 {
            return Verdict(level: .warn, symbol: "exclamationmark.triangle.fill", headline: "Аномалия бюджета LiteLLM", detail: "Шлюз сообщил расход \(Fmt.usd(s.spend)). Остаток и прогноз недоступны")
        }
        if s.budget?.isAvailable == false {
            return Verdict(level: .warn, symbol: "exclamationmark.triangle", headline: "Нет локальной оценки за день", detail: "Введите сверенную сумму через «Исправить расход…». Новые шаги будут учитываться автоматически")
        }
        let percent = s.spend / s.maxBudget * 100
        let resetClock = Fmt.clock(date(s.nextResetAt))
        let pace = dailyPace
        let outlook = pace.map { pace in
            let leftAtReset = Fmt.usdWhole(max(0, pace.maxBudget - pace.projectedSpend))
            return "К \(resetClock) останется ≈ \(leftAtReset)"
        } ?? "Показания периода ещё не прочитаны"

        if let runOutAt = pace?.exhaustsAt {
            let exhaust = runOutAt.timeIntervalSince(now) / 60
            let runOut = Fmt.clock(runOutAt)
            let level: Level = (exhaust < 60 || percent >= 90) ? .critical : .warn
            return Verdict(level: level, symbol: level == .critical ? "exclamationmark.octagon.fill" : "exclamationmark.triangle.fill",
                           headline: "Не хватит до сброса", detail: "Закончится около \(runOut), сброс в \(resetClock)")
        }
        if percent >= 90 {
            return Verdict(level: .critical, symbol: "exclamationmark.octagon.fill", headline: "Осталось меньше 10%", detail: outlook)
        }
        if percent >= 75 {
            return Verdict(level: .warn, symbol: "exclamationmark.triangle.fill", headline: "Осталось меньше 25%", detail: outlook)
        }
        guard let pace else {
            return Verdict(level: .idle, symbol: "hourglass", headline: "Темп пока не оценить", detail: outlook)
        }
        if pace.maxBudget - pace.projectedSpend < s.maxBudget * 0.1 {
            return Verdict(level: .warn, symbol: "exclamationmark.triangle.fill", headline: "Хватит впритык", detail: outlook)
        }
        return Verdict(level: .ok, symbol: "checkmark.circle.fill", headline: "Хватит до сброса", detail: outlook)
    }

    /// Сессия активна, пока идёт её выполнение. Отметку старше 30 минут считаем следом аварийного завершения.
    func isActive(_ session: SessionInfo) -> Bool {
        guard let at = running[session.id] else { return false }
        return now.timeIntervalSince1970 * 1000 - at < 30 * 60_000
    }

    var activeSessions: [SessionInfo] { sessions.filter(isActive) }

    func sessionTotal(_ session: SessionInfo) -> (cost: Double, subagentsCost: Double, descendants: Int) {
        let descendants = sessions.filter { $0.id != session.id && ($0.ancestorIds?.contains(session.id) ?? false) }
        let subagentsCost = descendants.reduce(0) { $0 + $1.cost }
        return (session.cost + subagentsCost, subagentsCost, descendants.count)
    }

    /// Завершённые сессии без заметных трат только засоряют список
    var recentSessions: [SessionInfo] {
        var costs = Dictionary(uniqueKeysWithValues: sessions.map { ($0.id, $0.cost) })
        for session in sessions {
            for ancestor in Set(session.ancestorIds ?? []) where ancestor != session.id && costs[ancestor] != nil {
                costs[ancestor]! += session.cost
            }
        }
        return sessions.lazy.filter { !self.isActive($0) && costs[$0.id]! >= 0.01 }.prefix(4).map { $0 }
    }

    func cacheIsLow(_ session: SessionInfo) -> Bool {
        guard let s = status else { return false }
        return session.contextTokens >= s.cacheMinContextTokens && session.cacheReadRatio < s.cacheMinReadRatio
    }

    func contextColor(_ tokens: Double) -> Color {
        let thresholds = (status?.contextThresholdsTokens ?? []).sorted()
        guard thresholds.count >= 3 else { return .accentColor }
        return tokens >= thresholds[2] ? .red : tokens >= thresholds[1] ? .orange : .accentColor
    }
}
