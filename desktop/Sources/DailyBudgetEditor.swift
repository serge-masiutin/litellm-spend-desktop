import SwiftUI

struct DailyBudgetEditor: View {
    @ObservedObject var monitor: Monitor
    @Environment(\.dismiss) private var dismiss
    @State private var day = Date()
    @State private var amount = ""
    @State private var error = ""
    @State private var saving = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Исправить расход за день").font(.title2.bold())
            DatePicker("День (UTC)", selection: $day, in: ...Date(), displayedComponents: .date)
                .environment(\.timeZone, TimeZone(secondsFromGMT: 0)!)
            TextField("Итог расхода, USD", text: $amount)
            Text("Введите сумму из usage LiteLLM за выбранный UTC-день на текущий момент. Она заменит учтённый итог; новые шаги будут прибавляться к ней. Серверный счётчик в этот день больше не используется.")
                .font(.callout).foregroundStyle(.secondary)
            if !error.isEmpty { Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Button("Отмена") { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button(saving ? "Сохранение…" : "Сохранить") { save() }
                    .keyboardShortcut(.defaultAction)
            }
            .disabled(saving)
        }
        .padding(24).frame(width: 460)
        .interactiveDismissDisabled(saving)
    }

    private func save() {
        let text = amount.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ",", with: ".")
        guard let value = Double(text), value.isFinite, value >= 0 else {
            error = "Укажите неотрицательную сумму в USD, например 125,50."
            return
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        let selectedDay = formatter.string(from: day)
        let environment = AppEnvironment(config: monitor.config, resources: AppEnvironment.current.resources)
        let storage = monitor.dir
        saving = true
        error = ""
        Task {
            do {
                try await Task.detached { try environment.correctDailyBudget(day: selectedDay, amount: value, storage: storage) }.value
                monitor.reload()
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
            saving = false
        }
    }
}
