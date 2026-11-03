import SwiftUI

struct Actions {
    var setMode: (NotifyMode) -> Void
    var openThresholds: () -> Void
    var setLogin: (Bool) -> Void
    var loginEnabled: () -> Bool
    var openConnection: () -> Void
    var installAdapter: () -> Void
    var connectTelegram: () -> Void
    var showAbout: () -> Void

    static let none = Actions(setMode: { _ in }, openThresholds: {}, setLogin: { _ in }, loginEnabled: { false }, openConnection: {}, installAdapter: {}, connectTelegram: {}, showAbout: {})
}

struct MainView: View {
    @ObservedObject var monitor: Monitor
    let actions: Actions

    var body: some View {
        ScrollView {
            MainContent(monitor: monitor, actions: actions)
                .padding(.horizontal, 20)
                .padding(.top, 34)
                .padding(.bottom, 20)
        }
        .frame(minWidth: 520, minHeight: 480)
    }
}

struct MainContent: View {
    @ObservedObject var monitor: Monitor
    let actions: Actions
    @State private var showAllAlerts = false
    @State private var showBudgetCorrection = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if !monitor.problems.isEmpty { problemsCard }
            budgetCard
            if let plan = monitor.planningBudget {
                MonthlyBudgetCard(status: monitor.status, plan: plan, resetIsPast: monitor.resetIsPast, now: monitor.now)
            }
            sessionsCard
            alertsCard
            PanelSettings(monitor: monitor, actions: actions)
        }
    }

    // MARK: Бюджет

    private var budgetCard: some View {
        let verdict = monitor.verdict
        return Card {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    SectionTitle(title: "Бюджет ключа на сутки", help: "Серверный счётчик включает всех клиентов. При сбое локальная оценка включает только наблюдённые шаги LiteLLM")
                    Spacer()
                    Button("Исправить расход…") { showBudgetCorrection = true }
                        .buttonStyle(.link).disabled(monitor.isDemo)
                }

                if let budget = monitor.status?.budget {
                    Label("Локальный учёт", systemImage: "internaldrive")
                        .font(.caption).foregroundStyle(.secondary)
                        .help(budget.detail)
                }

                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: verdict.symbol)
                        .font(.system(size: 28))
                        .foregroundStyle(verdict.level.color)
                        .symbolRenderingMode(.hierarchical)
                        .contentTransition(.symbolEffect(.replace))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verdict.headline).font(.title3.weight(.semibold))
                        Text(verdict.detail).foregroundStyle(.secondary)
                    }
                    .motion(value: verdict.headline)
                }

                if let status = monitor.status, let left = monitor.left {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(status.budget == nil ? "" : "≈ ")\(Fmt.usd(status.spend))")
                            .font(.system(size: 38, weight: .semibold, design: .rounded))
                            .contentTransition(.numericText(value: status.spend))
                            .monospacedDigit()
                        Text("из \(Fmt.usdWhole(status.maxBudget))").font(.title3).foregroundStyle(.secondary)
                        Spacer()
                        VStack(alignment: .trailing, spacing: 0) {
                            Text("\(status.budget == nil ? "" : "≈ ")\(Fmt.usd(left))").font(.title3.weight(.medium)).contentTransition(.numericText(value: left)).monospacedDigit()
                            Text("осталось").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .motion(value: status.spend)

                    BudgetBar(fraction: monitor.fraction, forecast: monitor.forecastFraction, level: verdict.level)

                    HStack(spacing: 16) {
                        if let toReset = monitor.minutesToReset, !monitor.resetIsPast {
                            Label("Сброс в \(Fmt.clock(date(status.nextResetAt))), через \(Fmt.duration(minutes: toReset))", systemImage: "clock.arrow.circlepath")
                        }
                        Spacer()
                        if let pace = monitor.dailyPace {
                            Label("\(Fmt.rate(pace.ratePerHour)) за \(pace.windowMinutes == 60 ? "час" : Fmt.duration(minutes: pace.windowMinutes)) · предел \(Fmt.rate(pace.allowancePerHour))", systemImage: "speedometer")
                                .help("Темп — расход за \(pace.windowLabel) по часам, паузы его снижают. После ручной поправки учитываются только новые шаги. Предел — остаток ÷ время до сброса.")
                        }
                    }
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .labelStyle(.titleAndIcon)

                    SpendChart(monitor: monitor)
                    freshness(status)
                } else if let status = monitor.status {
                    Text("Лимит \(Fmt.usdWhole(status.maxBudget)). Остаток и прогноз пока недоступны; учёт сессий продолжается.")
                        .font(.caption).foregroundStyle(.secondary)
                    freshness(status)
                }
            }
        }
        .sheet(isPresented: $showBudgetCorrection) { DailyBudgetEditor(monitor: monitor) }
    }

    @ViewBuilder private func freshness(_ status: KeyStatus) -> some View {
        let age = monitor.now.timeIntervalSince(date(status.updatedAt)) / 60
        if age > 30 {
            Label("Данные устарели: последний ответ модели был \(Fmt.ago(date(status.updatedAt), now: monitor.now))", systemImage: "exclamationmark.circle")
                .font(.caption)
                .foregroundStyle(.orange)
        } else {
            Text("Обновлено в \(Fmt.clock(date(status.updatedAt)))").font(.caption).foregroundStyle(.tertiary)
        }
    }

    // MARK: Сессии

    private var sessionsCard: some View {
        let active = monitor.activeSessions
        let recent = monitor.recentSessions
        let thresholds = monitor.status?.contextThresholdsTokens ?? []
        let scaleTop = thresholds.max() ?? 400_000
        return Card {
            VStack(alignment: .leading, spacing: 12) {
                SectionTitle(
                    title: "Сессии LiteLLM",
                    trailing: active.isEmpty ? nil : "\(active.count) \(Fmt.plural(active.count, "активная", "активные", "активных"))",
                    help: "Только наблюдённые шаги LiteLLM после обновления учёта. Другие провайдеры и старые смешанные итоги исключены"
                )
                if active.isEmpty && recent.isEmpty {
                    emptyState(symbol: "bolt.horizontal.circle", text: "Сессии появятся после первого шага через LiteLLM")
                } else {
                    if active.isEmpty {
                        emptyState(symbol: "moon.zzz", text: "Сейчас нет активных сессий LiteLLM")
                    }
                    ForEach(active) { SessionRow(session: $0, monitor: monitor, scaleTop: scaleTop, active: true) }
                    if !recent.isEmpty {
                        if !active.isEmpty { Divider() }
                        Text("Недавние").font(.subheadline).foregroundStyle(.secondary)
                        ForEach(recent) { SessionRow(session: $0, monitor: monitor, scaleTop: scaleTop, active: false) }
                    }
                }
            }
            .motion(value: active.map(\.id))
        }
    }

    private func emptyState(symbol: String, text: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: symbol)
            Text(text)
        }
        .font(.callout)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
    }

    // MARK: Оповещения

    private var alertsCard: some View {
        let shown = showAllAlerts ? monitor.alerts : Array(monitor.alerts.prefix(4))
        return Card {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("Оповещения").font(.headline)
                    Spacer()
                    if !monitor.alerts.isEmpty {
                        Button("Очистить все") { withAnimation(.smooth) { monitor.clearAlerts() } }
                            .buttonStyle(.link)
                    }
                }
                if monitor.alerts.isEmpty {
                    emptyState(symbol: "bell", text: "Оповещений нет")
                } else {
                    ForEach(shown, id: \.at) { alert in
                        AlertRow(alert: alert, now: monitor.now) { withAnimation(.smooth) { monitor.dismiss(alert) } }
                            .transition(.asymmetric(insertion: .opacity, removal: .opacity.combined(with: .move(edge: .trailing))))
                    }
                    if monitor.alerts.count > 4 {
                        Button(showAllAlerts ? "Свернуть" : "Показать все (\(monitor.alerts.count))") {
                            withAnimation(.smooth) { showAllAlerts.toggle() }
                        }
                        .buttonStyle(.link)
                    }
                }
            }
        }
    }

    private var problemsCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 6) {
                Label("Не удалось прочитать часть данных", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
                    .font(.headline)
                ForEach(monitor.problems, id: \.self) { Text($0).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
            }
        }
    }
}

// MARK: - Строки

struct SessionRow: View {
    let session: SessionInfo
    @ObservedObject var monitor: Monitor
    let scaleTop: Double
    let active: Bool

    var body: some View {
        let total = monitor.sessionTotal(session)
        return HStack(alignment: .center, spacing: 12) {
            Group {
                if active {
                    PulseDot(color: .green)
                } else {
                    Circle().fill(Color.primary.opacity(0.18)).frame(width: 9, height: 9)
                }
            }
            .frame(width: 14)

            VStack(alignment: .leading, spacing: 3) {
                Text(session.title.isEmpty ? Fmt.project(session.directory) : session.title)
                    .fontWeight(active ? .medium : .regular)
                    .lineLimit(1)
                Text("\(Fmt.model(session.model)) · \(Fmt.project(session.directory))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text(session.stepSummary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if total.descendants > 0 {
                    Text("Основная ≈ \(Fmt.usd(session.cost)) · Сабагенты (\(total.descendants)) ≈ \(Fmt.usd(total.subagentsCost))")
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if monitor.cacheIsLow(session) {
                    Label("Чтение кеша ниже порога", systemImage: "bolt.slash.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .help("Часть входа не читается из кеша: она оплачивается по тарифу свежих токенов или записи кеша")
                }
            }

            Spacer(minLength: 8)

            VStack(alignment: .trailing, spacing: 3) {
                Text(Fmt.usd(total.cost)).font(.body.weight(.semibold)).monospacedDigit()
                    .contentTransition(.numericText(value: total.cost))
                    .accessibilityLabel("Общая стоимость сессии с сабагентами: \(Fmt.usd(total.cost))")
                Text(active ? "сейчас" : Fmt.ago(date(session.lastStepAt), now: monitor.now))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(minWidth: 64, alignment: .trailing)

            ContextMeter(tokens: session.contextTokens, scaleTop: scaleTop, color: monitor.contextColor(session.contextTokens))
        }
        .motion(value: total.cost)
        .accessibilityElement(children: .combine)
        .help(session.stepDetails)
    }
}

struct AlertRow: View {
    let alert: AlertInfo
    let now: Date
    let dismiss: () -> Void
    @State private var hovering = false

    private var symbol: (name: String, color: Color) {
        switch alert.severity {
        case "critical": return ("exclamationmark.octagon.fill", .red)
        case "warn": return ("exclamationmark.triangle.fill", .orange)
        default: return ("info.circle.fill", .blue)
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol.name).foregroundStyle(symbol.color).frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    Text(alert.title).lineLimit(2)
                    Spacer(minLength: 8)
                    Text(Fmt.stamp(date(alert.at), now: now)).font(.caption).foregroundStyle(.secondary).monospacedDigit()
                    Button(action: dismiss) {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(hovering ? .secondary : .tertiary)
                    }
                    .buttonStyle(.plain)
                    .help("Очистить")
                    .accessibilityLabel("Очистить оповещение")
                }
                Text([alert.subtitle.map { "«\(Fmt.clip($0, 48))»" }, alert.body].compactMap { $0 }.joined(separator: " "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .onHover { hovering = $0 }
    }
}
