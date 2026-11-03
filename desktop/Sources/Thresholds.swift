import SwiftUI

/// Редактор порогов. Пишет тот же config.json, который читает плагин (он перечитывает файл при изменении).
/// Остальные поля файла сохраняются как есть: меняются только перечисленные здесь.
struct ThresholdValues: Equatable {
    var resetHourUtc: Double
    var keyPercent: [Double]
    var sessionStepUsd: [Double]
    var contextK: [Double]
    var cacheRatioPercent: Double
    var cacheMinContextK: Double

    var problem: String? {
        if resetHourUtc < 0 || resetHourUtc > 23 || resetHourUtc != resetHourUtc.rounded() { return "Час сброса: целое число от 0 до 23" }
        if !(keyPercent[0] < keyPercent[1] && keyPercent[1] < keyPercent[2]) { return "Пороги бюджета должны идти по возрастанию" }
        if keyPercent[0] < 1 || keyPercent[2] > 100 { return "Пороги бюджета: от 1 до 100%" }
        if !(contextK[0] < contextK[1] && contextK[1] < contextK[2]) { return "Пороги контекста должны идти по возрастанию" }
        if contextK[0] < 1 { return "Контекст: не меньше 1k" }
        if sessionStepUsd.contains(where: { $0 < 0.01 }) { return "Шаг стоимости: не меньше $0.01" }
        if cacheRatioPercent < 0 || cacheRatioPercent > 100 { return "Кеш: от 0 до 100%" }
        if cacheMinContextK < 0 { return "Контекст для проверки кеша: не меньше 0" }
        return nil
    }
}

final class ThresholdStore: ObservableObject {
    @Published var values: ThresholdValues
    @Published var saved: ThresholdValues
    @Published var error: String?

    let url: URL
    let defaultsURL: URL

    init(url: URL = AppEnvironment.current.config, defaultsURL: URL = AppEnvironment.current.defaults) {
        self.url = url
        self.defaultsURL = defaultsURL
        let empty = ThresholdValues(resetHourUtc: 0, keyPercent: [50, 75, 90], sessionStepUsd: [3, 5, 2], contextK: [150, 250, 400], cacheRatioPercent: 50, cacheMinContextK: 100)
        values = empty
        saved = empty
        load()
    }

    private func readRoot(_ file: URL) throws -> [String: Any] {
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: file))
        guard let root = object as? [String: Any] else { throw NSError(domain: "config", code: 1, userInfo: [NSLocalizedDescriptionKey: "\(file.lastPathComponent): ожидался объект"]) }
        return root
    }

    private func parse(_ root: [String: Any]) throws -> ThresholdValues {
        func fail(_ path: String) -> Error { NSError(domain: "config", code: 2, userInfo: [NSLocalizedDescriptionKey: "В config.json нет поля \(path)"]) }
        guard let key = root["keyBudget"] as? [String: Any], let resetHour = key["resetHourUtc"] as? Double, let percents = key["thresholdsPercent"] as? [Double], percents.count == 3 else { throw fail("keyBudget.resetHourUtc и thresholdsPercent (3 числа)") }
        guard let session = root["session"] as? [String: Any], let tiers = session["tiers"] as? [[String: Any]], tiers.count == 3 else { throw fail("session.tiers (3 уровня)") }
        let steps = try tiers.sorted { ($0["minOutputPricePerMillion"] as? Double ?? 0) > ($1["minOutputPricePerMillion"] as? Double ?? 0) }
            .map { tier -> Double in guard let step = tier["stepUsd"] as? Double else { throw fail("session.tiers[].stepUsd") }; return step }
        guard let context = root["context"] as? [String: Any], let tokens = context["thresholdsTokens"] as? [Double], tokens.count == 3 else { throw fail("context.thresholdsTokens (3 числа)") }
        guard let cache = root["cache"] as? [String: Any], let ratio = cache["minReadRatio"] as? Double, let minContext = cache["minContextTokens"] as? Double else { throw fail("cache") }
        return ThresholdValues(resetHourUtc: resetHour, keyPercent: percents, sessionStepUsd: steps, contextK: tokens.map { $0 / 1000 }, cacheRatioPercent: ratio * 100, cacheMinContextK: minContext / 1000)
    }

    func load() {
        do {
            let parsed = try parse(readRoot(url))
            values = parsed
            saved = parsed
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    var isDirty: Bool { values != saved }

    func resetToDefaults() {
        do { values = try parse(readRoot(defaultsURL)) } catch { self.error = error.localizedDescription }
    }

    func save() {
        if let problem = values.problem { error = problem; return }
        do {
            var root = try readRoot(url)
            var key = root["keyBudget"] as! [String: Any]
            key["thresholdsPercent"] = values.keyPercent
            key["resetHourUtc"] = values.resetHourUtc
            root["keyBudget"] = key

            var session = root["session"] as! [String: Any]
            var tiers = session["tiers"] as! [[String: Any]]
            let order = tiers.indices.sorted { (tiers[$0]["minOutputPricePerMillion"] as? Double ?? 0) > (tiers[$1]["minOutputPricePerMillion"] as? Double ?? 0) }
            for (position, index) in order.enumerated() { tiers[index]["stepUsd"] = values.sessionStepUsd[position] }
            session["tiers"] = tiers
            root["session"] = session

            var context = root["context"] as! [String: Any]
            context["thresholdsTokens"] = values.contextK.map { ($0 * 1000).rounded() }
            root["context"] = context

            var cache = root["cache"] as! [String: Any]
            cache["minReadRatio"] = values.cacheRatioPercent / 100
            cache["minContextTokens"] = (values.cacheMinContextK * 1000).rounded()
            root["cache"] = cache

            let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
            let temp = url.appendingPathExtension("tmp")
            try data.write(to: temp)
            _ = try FileManager.default.replaceItemAt(url, withItemAt: temp)
            saved = values
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}

private struct NumberRow: View {
    let title: String
    let hint: String?
    @Binding var value: Double
    let unit: String
    var format: FloatingPointFormatStyle<Double> = .number.precision(.fractionLength(0...2))

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                if let hint { Text(hint).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer()
            TextField("", value: $value, format: format)
                .textFieldStyle(.roundedBorder)
                .multilineTextAlignment(.trailing)
                .monospacedDigit()
                .frame(width: 72)
            Text(unit).foregroundStyle(.secondary).frame(width: 26, alignment: .leading)
        }
    }
}

struct ThresholdsView: View {
    @ObservedObject var store: ThresholdStore
    var close: () -> Void = {}

    private func group(_ title: String, _ symbol: String, _ footer: String, @ViewBuilder _ rows: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(title, systemImage: symbol).font(.headline)
            rows()
            Text(footer).font(.caption).foregroundStyle(.secondary)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color(nsColor: .controlBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.primary.opacity(0.07)))
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 12) {
                    group("Бюджет ключа", "gauge.with.dots.needle.67percent", "Оповещение, когда израсходована эта доля суточного бюджета. Час сброса зависит от настроек вашего LiteLLM") {
                        NumberRow(title: "Сброс бюджета", hint: "каждый день в этот час по UTC", value: $store.values.resetHourUtc, unit: "ч", format: .number.precision(.fractionLength(0)))
                        ForEach(0..<3, id: \.self) { NumberRow(title: ["Первое", "Второе", "Третье"][$0], hint: nil, value: $store.values.keyPercent[$0], unit: "%") }
                    }
                    group("Стоимость сессии", "dollarsign.circle", "Оповещение при каждом превышении кратного значения. Модели делятся по цене вывода") {
                        NumberRow(title: "Дорогие модели", hint: "вывод от $15 за 1M токенов", value: $store.values.sessionStepUsd[0], unit: "$")
                        NumberRow(title: "Средние модели", hint: "от $5", value: $store.values.sessionStepUsd[1], unit: "$")
                        NumberRow(title: "Недорогие модели", hint: "остальные", value: $store.values.sessionStepUsd[2], unit: "$")
                    }
                    group("Размер контекста", "text.alignleft", "Чем больше контекст, тем дороже каждый шаг. Помогает /compact или новая сессия") {
                        ForEach(0..<3, id: \.self) { NumberRow(title: ["Первое", "Второе", "Третье"][$0], hint: nil, value: $store.values.contextK[$0], unit: "k") }
                    }
                    group("Кеш", "bolt", "Предупреждение, если кеш читается хуже этой доли два шага подряд") {
                        NumberRow(title: "Минимальное чтение кеша", hint: nil, value: $store.values.cacheRatioPercent, unit: "%")
                        NumberRow(title: "Проверять при контексте от", hint: nil, value: $store.values.cacheMinContextK, unit: "k")
                    }
                }
                .padding(16)
            }
            Divider()
            HStack(spacing: 10) {
                if let message = store.error ?? store.values.problem {
                    Label(message, systemImage: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(.red).lineLimit(2)
                } else if !store.isDirty {
                    Label("Сохранено. Плагин применит пороги на следующем шаге", systemImage: "checkmark.circle").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("По умолчанию") { store.resetToDefaults() }
                Button("Сохранить") { store.save() }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .disabled(!store.isDirty || store.values.problem != nil)
            }
            .padding(12)
        }
        .frame(minWidth: 460, minHeight: 540)
    }
}
