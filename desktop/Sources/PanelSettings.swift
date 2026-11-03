import SwiftUI

/// Единственное место настройки панели и подключений; расчёты и данные разделов выше не меняются.
struct PanelSettings: View {
    @ObservedObject var monitor: Monitor
    let actions: Actions
    @State private var login = false
    @StateObject private var budget = BudgetPlanSettings()

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 18) {
                SectionTitle(title: "Настройки")

                VStack(alignment: .leading, spacing: 10) {
                    groupTitle("Личный месячный бюджет")
                    HStack {
                        Text("На месяц, $")
                        TextField("Например, 4000", text: $budget.monthly).textFieldStyle(.roundedBorder)
                        Button("Сохранить") { budget.save(); monitor.reload() }.buttonStyle(.bordered)
                    }
                    Text(budget.message.isEmpty ? "Для планирования. Лимит ключа LiteLLM не меняется." : budget.message)
                        .font(.caption).foregroundStyle(.secondary)
                }

                Divider()

                VStack(alignment: .leading, spacing: 12) {
                    groupTitle("Уведомления в macOS")
                    Picker("Уведомления в macOS", selection: Binding(get: { monitor.settings.mode }, set: actions.setMode)) {
                        ForEach(NotifyMode.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    Text(notificationDetail)
                        .font(.caption).foregroundStyle(.secondary)
                    settingsRow("Пороги оповещений", detail: "Бюджет, стоимость шага, контекст и кеш", symbol: "slider.horizontal.3", button: "Настроить…", action: actions.openThresholds)
                }

                Divider()

                VStack(alignment: .leading, spacing: 16) {
                    groupTitle("Подключения")
                    settingsRow("LiteLLM", detail: "Адрес шлюза и API-ключ", symbol: "network", button: "Настроить…", action: actions.openConnection)
                    settingsRow("OpenCode", detail: "Адаптер для учёта расходов LiteLLM", symbol: "puzzlepiece.extension", button: "Установить…", action: actions.installAdapter)
                    settingsRow("Telegram", detail: "Привязка личного бота через Terminal", symbol: "paperplane", button: "Подключить…", action: actions.connectTelegram)
                }

                Divider()

                VStack(alignment: .leading, spacing: 14) {
                    groupTitle("Приложение")
                    Toggle(isOn: Binding(get: { login }, set: { actions.setLogin($0); login = actions.loginEnabled() })) {
                        HStack {
                            Label("Запускать при входе в macOS", systemImage: "power")
                            Spacer()
                        }
                    }
                    .toggleStyle(.switch)

                    HStack {
                        Text("LiteLLM Spend · \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as! String)")
                            .font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Button("О приложении…", action: actions.showAbout)
                            .buttonStyle(.link)
                    }
                }
            }
        }
        .onAppear { login = actions.loginEnabled(); budget.load() }
    }

    private var notificationDetail: String {
        switch monitor.settings.mode {
        case .all: return "Все системные оповещения. Не влияет на сообщения Telegram."
        case .critical: return "Только критические системные оповещения. Не влияет на Telegram."
        case .off: return "Без системных уведомлений; события сохраняются в списке."
        }
    }

    private func groupTitle(_ title: String) -> some View {
        Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
    }

    private func settingsRow(_ title: String, detail: String, symbol: String, button: String, action: @escaping () -> Void) -> some View {
        HStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 16))
                .foregroundStyle(.secondary)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.body.weight(.medium))
                Text(detail).font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 12)
            Button(button, action: action)
                .buttonStyle(.bordered).controlSize(.small)
                .accessibilityLabel("\(title): \(button)")
        }
    }
}
