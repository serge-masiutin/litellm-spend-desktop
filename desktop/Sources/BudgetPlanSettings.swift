import Foundation
import CoreFoundation
import SwiftUI

/// Личные ориентиры, не изменяющие лимиты на стороне LiteLLM.
final class BudgetPlanSettings: ObservableObject {
    @Published var monthly = ""
    @Published var message = ""
    let config: URL

    init(config: URL = AppEnvironment.current.config) {
        self.config = config
    }

    func load() {
        do {
            monthly = try Self.readBudget(at: config).map { String($0.monthlyUsd) } ?? ""
            message = ""
        } catch { message = error.localizedDescription }
    }

    static func readBudget(at config: URL) throws -> PlanningBudget? {
        guard let root = try JSONSerialization.jsonObject(with: Data(contentsOf: config)) as? [String: Any] else {
            throw NSError(domain: "BudgetPlan", code: 1, userInfo: [NSLocalizedDescriptionKey: "В config.json ожидался объект"])
        }
        guard let raw = root["planningBudget"] else { return nil }
        guard let budget = raw as? [String: Any], let value = budget["monthlyUsd"] as? NSNumber,
              CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite, value.doubleValue > 0 else {
            throw NSError(domain: "BudgetPlan", code: 1, userInfo: [NSLocalizedDescriptionKey: "Некорректный месячный бюджет в config.json"])
        }
        return PlanningBudget(monthlyUsd: value.doubleValue)
    }

    func save() {
        do {
            guard let month = number(monthly) else {
                throw problem("Укажите положительный месячный бюджет в долларах")
            }
            var root = try readRoot()
            root["planningBudget"] = ["monthlyUsd": month]
            try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys]).write(to: config, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: config.path)
            message = "Сохранено. Лимиты LiteLLM не изменены."
        } catch { message = error.localizedDescription }
    }

    private func readRoot() throws -> [String: Any] {
        guard let root = try JSONSerialization.jsonObject(with: Data(contentsOf: config)) as? [String: Any] else {
            throw problem("В config.json ожидался объект")
        }
        return root
    }

    private func number(_ text: String) -> Double? {
        guard let value = Double(text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ",", with: ".")), value.isFinite, value > 0 else { return nil }
        return value
    }

    private func problem(_ text: String) -> NSError {
        NSError(domain: "BudgetPlan", code: 1, userInfo: [NSLocalizedDescriptionKey: text])
    }
}
