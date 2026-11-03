import Charts
import SwiftUI

/// Бюджет всегда относится к текущему календарному месяцу UTC, а не возрасту истории.
struct MonthlyCalendar {
    let start: Date
    let end: Date
    let daysInMonth: Int
    let elapsedDays: Int
    let label: String

    init(now: Date) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        start = calendar.date(from: calendar.dateComponents([.year, .month], from: now))!
        end = calendar.date(byAdding: .month, value: 1, to: start)!
        daysInMonth = calendar.range(of: .day, in: .month, for: now)!.count
        elapsedDays = calendar.component(.day, from: now)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ru_RU")
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = "d MMMM yyyy"
        label = "1–\(formatter.string(from: calendar.date(byAdding: .day, value: -1, to: end)!))"
    }

    func estimate(from status: KeyStatus?) -> MonthlyEstimate? {
        guard let status else { return nil }
        let period = Date(timeIntervalSince1970: status.periodStartAt / 1000)
        guard period >= start && period < end else { return nil }
        return status.monthlyEstimate
    }
}

/// Темп для неравномерных дней: норма пересчитывается из остатка, а не делится поровну с 1-го числа.
struct MonthlyPace {
    let todaySpend: Double
    let remaining: Double
    let daysLeft: Int
    /// Остаток на начало сегодняшнего дня ÷ дни до конца месяца, включая сегодня.
    /// Не меняется в течение дня, поэтому сегодняшние траты можно сравнить с ним.
    let dailyAllowance: Double
    let keyLimit: Double
    /// Сколько дней по полному лимиту ключа покрывает остаток.
    let fullDays: Int

    init(days: [MonthlyEstimate.Day], budget: Double, keyLimit: Double, calendar: MonthlyCalendar) {
        let spent = days.reduce(0) { $0 + $1.spend }
        todaySpend = days.first { $0.day == calendar.elapsedDays }?.spend ?? 0
        remaining = budget - spent
        daysLeft = calendar.daysInMonth - calendar.elapsedDays + 1
        dailyAllowance = max(0, budget - (spent - todaySpend)) / Double(daysLeft)
        self.keyLimit = keyLimit
        fullDays = Int(max(0, remaining) / keyLimit)
    }

    var limitedByKey: Bool { dailyAllowance >= keyLimit }
    var exhausted: Bool { remaining <= 0 }
    var plannedDaily: Double { exhausted ? 0 : min(dailyAllowance, keyLimit) }
    var todayOverPlan: Bool { todaySpend > plannedDaily }
}

/// Месячная оценка по ключу: неполная история не превращается в доступный остаток.
struct MonthlyBudgetCard: View {
    let status: KeyStatus?
    let plan: PlanningBudget
    let resetIsPast: Bool
    let now: Date

    var body: some View {
        let calendar = MonthlyCalendar(now: now)
        Card {
            VStack(alignment: .leading, spacing: 16) {
                SectionTitle(title: "Месячный бюджет", trailing: calendar.label, help: "С первого по последнее число календарного месяца, UTC. Дневные максимумы ключа, локальные оценки при сбоях и ручные поправки. Пропущенный расход может отсутствовать. «Можно в день» каждый день пересчитывается из остатка: дорогие дни уменьшают норму, лёгкие увеличивают.")
                if let month = calendar.estimate(from: status) {
                    summary(month, daysInMonth: calendar.daysInMonth)
                    if let days = month.days, let status {
                        let pace = MonthlyPace(days: days, budget: plan.monthlyUsd, keyLimit: status.maxBudget, calendar: calendar)
                        MonthlySpendChart(days: days, pace: pace, calendar: calendar)
                        if days.contains(where: { $0.source != nil }) {
                            Text("Включены локальные оценки и ручные поправки")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        metrics(pace, partial: month.observedDays < calendar.elapsedDays)
                    } else {
                        Label("Дневная разбивка появится после следующего ответа LiteLLM", systemImage: "chart.bar.xaxis")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                } else if let error = status?.monthlyError {
                    Label(error, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(.orange)
                } else {
                    Text("Бюджет \(Fmt.usd(plan.monthlyUsd)). Оценка появится после ответа LiteLLM.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                if resetIsPast {
                    Label("Новый период: ожидаем свежие показания", systemImage: "clock.arrow.circlepath")
                        .font(.caption).foregroundStyle(.orange)
                }
            }
        }
    }

    private func summary(_ month: MonthlyEstimate, daysInMonth: Int) -> some View {
        let fraction = month.observedSpend / plan.monthlyUsd
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("≈ \(Fmt.usd(month.observedSpend))")
                        .font(.system(size: 32, weight: .semibold, design: .rounded)).monospacedDigit()
                        .contentTransition(.numericText(value: month.observedSpend))
                }
                Spacer(minLength: 12)
                VStack(alignment: .trailing, spacing: 4) {
                    Text("Бюджет на месяц").font(.caption).foregroundStyle(.secondary)
                    Text(Fmt.usdWhole(plan.monthlyUsd)).font(.title3.weight(.medium)).monospacedDigit()
                }
                .padding(.bottom, 3)
            }
            ProgressView(value: min(1, fraction)).tint(.accentColor)
                .accessibilityLabel("Доля месячного бюджета по наблюдениям ключа")
                .accessibilityValue(String(format: "%.1f%%", fraction * 100))
            HStack {
                Text("\(String(format: "%.1f%%", fraction * 100)) бюджета")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer(minLength: 8)
                Text("Данные: \(month.observedDays) из \(daysInMonth) дней")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(month.observedDays < daysInMonth ? Color.orange : Color.secondary)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Capsule().fill(Color.primary.opacity(0.05)))
            }
        }
        .motion(value: month.observedSpend)
    }

    private func metrics(_ pace: MonthlyPace, partial: Bool) -> some View {
        let days = "\(pace.daysLeft) \(Fmt.plural(pace.daysLeft, "день", "дня", "дней"))"
        let overspent = pace.remaining < 0
        let coversAll = pace.fullDays >= pace.daysLeft
        return HStack(alignment: .top, spacing: 16) {
            metric(overspent ? "Перерасход" : "Остаток", value: "≈ \(Fmt.usd(abs(pace.remaining)))",
                   detail: partial ? "По имеющимся данным" : "До конца месяца \(days)",
                   tint: overspent ? .red : nil)
            Divider().frame(height: 42)
            metric("Можно в день", value: "≈ \(Fmt.usd(pace.plannedDaily))",
                   detail: pace.exhausted ? "Бюджет исчерпан" : pace.limitedByKey ? "Упирается в лимит ключа" : "Остаток ÷ \(days)")
            Divider().frame(height: 42)
            metric("Дни по \(Fmt.usdWhole(pace.keyLimit))", value: "\(min(pace.fullDays, pace.daysLeft)) из \(pace.daysLeft)",
                   detail: pace.exhausted ? "Бюджет исчерпан" : coversAll ? "Хватит на максимум каждый день" : "Если в остальные почти не тратить")
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.035)))
    }

    private func metric(_ title: String, value: String, detail: String, tint: Color? = nil) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title3.weight(.semibold)).monospacedDigit().foregroundStyle(tint ?? .primary)
            Text(detail).font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct MonthlySpendChart: View {
    let days: [MonthlyEstimate.Day]
    let pace: MonthlyPace
    let calendar: MonthlyCalendar
    @State private var selectedDay: Int?

    private var missingDays: [Int] {
        let observed = Set(days.map(\.day))
        return (1...calendar.elapsedDays).filter { !observed.contains($0) }
    }

    private var selection: String {
        guard let day = selectedDay else { return "Расход по дням · UTC" }
        guard day <= calendar.elapsedDays else { return "\(day)-е · можно ≈ \(Fmt.usd(pace.plannedDaily))" }
        guard let reading = days.first(where: { $0.day == day }) else { return "\(day)-е · нет данных" }
        let source = reading.source.map { $0 == .manual ? " · ручная поправка" : " · локальная оценка" } ?? ""
        if day == calendar.elapsedDays {
            return "Сегодня · ≈ \(Fmt.usd(reading.spend)) из \(Fmt.usd(pace.plannedDaily))\(source) · день не завершён"
        }
        return "\(day)-е · ≈ \(Fmt.usd(reading.spend))\(source)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(selection).font(.caption.weight(.medium)).foregroundStyle(.secondary).monospacedDigit()
            chart
            HStack(spacing: 14) {
                Label("Показания", systemImage: "square.fill").foregroundStyle(Color.accentColor)
                Label("Нет данных", systemImage: "xmark").foregroundStyle(.secondary)
                Spacer(minLength: 0)
                if !pace.exhausted {
                    Text("┄ Можно \(Fmt.usdWhole(pace.plannedDaily))/день до конца месяца").foregroundStyle(.secondary)
                }
            }
            .font(.caption2)
        }
    }

    private var chart: some View {
        Chart {
            ForEach(days) { reading in
                if reading.spend > 0 {
                    BarMark(x: .value("День", reading.day), yStart: .value("Оценка, $", 0), yEnd: .value("Оценка, $", reading.spend), width: .fixed(10))
                        .foregroundStyle((reading.day == calendar.elapsedDays && pace.todayOverPlan ? Color.orange : Color.accentColor).gradient)
                        .cornerRadius(3)
                        .opacity(selectedDay == nil || selectedDay == reading.day ? 1 : 0.45)
                } else {
                    PointMark(x: .value("День", reading.day), y: .value("Нулевое показание", 0))
                        .symbolSize(16).foregroundStyle(Color.accentColor)
                }
            }
            ForEach(missingDays, id: \.self) { day in
                PointMark(x: .value("День", day), y: .value("Нет данных", 0))
                    .symbol(.cross).symbolSize(14).foregroundStyle(Color.secondary.opacity(0.45))
            }
            if !pace.exhausted {
                RuleMark(xStart: .value("С", Double(calendar.elapsedDays) - 0.5), xEnd: .value("По", Double(calendar.daysInMonth) + 0.5),
                         y: .value("Можно в день", pace.plannedDaily))
                    .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
                    .foregroundStyle(Color.secondary.opacity(0.8))
            }
            if let day = selectedDay {
                RuleMark(x: .value("Выбранный день", day))
                    .foregroundStyle(Color.primary.opacity(0.15))
            }
        }
        .chartXScale(domain: 0.5...(Double(calendar.daysInMonth) + 0.5))
        .chartYScale(domain: 0...(max(pace.plannedDaily, days.map(\.spend).max() ?? 0, 1) * 1.15))
        .chartXAxis {
            AxisMarks(values: [1, 5, 10, 15, 20, 25, calendar.daysInMonth]) { value in
                AxisValueLabel(anchor: value.as(Int.self) == calendar.daysInMonth ? .topTrailing : .top) {
                    if let day = value.as(Int.self) { Text(String(day)) }
                }
            }
        }
        .chartYAxis {
            AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) { value in
                AxisGridLine().foregroundStyle(Color.primary.opacity(0.06))
                AxisValueLabel { if let number = value.as(Double.self) { Text(Fmt.usdWhole(number)) } }
            }
        }
        .chartOverlay { proxy in
            GeometryReader { geometry in
                Rectangle().fill(.clear).contentShape(Rectangle())
                    .onContinuousHover { phase in
                        switch phase {
                        case .active(let location):
                            if let frame = plotFrame(proxy, geometry), frame.contains(location), let value = proxy.value(atX: location.x - frame.minX, as: Double.self) {
                                selectedDay = Int(value.rounded())
                            } else { selectedDay = nil }
                        case .ended: selectedDay = nil
                        }
                    }
            }
        }
        .frame(height: 140)
        .accessibilityLabel("Дневные максимумы расхода ключа за месяц. Крестики — дни без данных, а не нулевые расходы. Пунктир — сколько можно тратить в день до конца месяца, исходя из остатка.")
    }

    private func plotFrame(_ proxy: ChartProxy, _ geometry: GeometryProxy) -> CGRect? {
        if #available(macOS 14, *) {
            guard let anchor = proxy.plotFrame else { return nil }
            return geometry[anchor]
        } else {
            return geometry[proxy.plotAreaFrame]
        }
    }
}
