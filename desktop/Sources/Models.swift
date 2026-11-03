import Foundation
import SwiftUI

// Данные пишет плагин litellm-spend в ~/.local/share/opencode/litellm-spend

struct PlanningBudget: Decodable {
    let monthlyUsd: Double
}

struct MonthlyEstimate: Decodable {
    struct Day: Decodable, Identifiable {
        let day: Int
        let spend: Double
        var source: LocalBudgetInfo.Source? = nil
        var id: Int { day }
    }
    let observedSpend: Double
    let observedDays: Int
    let elapsedDays: Int
    let daysInMonth: Int
    let firstSampleAt: Double
    // Старый плагин ещё может писать итог без дневной разбивки во время обновления.
    let days: [Day]?
}

struct KeyStatus: Decodable {
    var budget: LocalBudgetInfo? = nil
    var budgetSamples: [BudgetSample]? = nil
    let updatedAt: Double
    let spend: Double
    let maxBudget: Double
    let periodStartAt: Double
    let nextResetAt: Double
    // Окно темпа из config.forecast; старый плагин этих полей не пишет до перезагрузки OpenCode.
    let paceWindowMinutes: Double?
    let paceMinWindowMinutes: Double?
    let thresholdsPercent: [Double]
    let contextThresholdsTokens: [Double]
    let activeWithinMinutes: Double
    let cacheMinContextTokens: Double
    let cacheMinReadRatio: Double
    let planningBudget: PlanningBudget?
    let monthlyEstimate: MonthlyEstimate?
    let monthlyError: String?
}

struct BudgetSample: Decodable {
    let t: Double
    let spend: Double
}

struct LocalBudgetInfo: Decodable {
    enum Source: String, Decodable { case local, manual }
    let source: Source
    let gatewaySpend: Double?
    let observedSteps: Int
    let unpricedSteps: Int
    let firstStepAt: Double?
    let correctedAt: Double?

    var title: String { source == .manual ? "Ручная поправка + новые шаги" : "Локальная оценка" }
    var isAvailable: Bool { source == .manual || observedSteps > unpricedSteps }
    var detail: String {
        let coverage = source == .manual ? "После поправки учитываются только наблюдённые шаги LiteLLM." : "Пропущенные запросы и другие клиенты не учтены."
        var text = "Учтено шагов LiteLLM: \(observedSteps). \(coverage) Серверный счётчик не используется до 00:00 UTC."
        if unpricedSteps > 0 { text += " Шагов с неизвестной ценой: \(unpricedSteps)." }
        if let spend = gatewaySpend { text += " LiteLLM сообщил \(Fmt.usd(spend))." }
        return text
    }
}

struct ModelRef: Decodable {
    let providerID: String
    let id: String
    let variant: String?
}

struct SessionInfo: Decodable, Identifiable {
    var lastStepTokens: StepTokens? = nil
    var lastStepCharges: StepCharges? = nil
    var accountingVersion: Int? = nil
    let id: String
    let title: String
    let directory: String
    let ancestorIds: [String]?
    let ancestryComplete: Bool?
    let model: ModelRef
    let cost: Double
    let steps: Int
    let lastStepAt: Double
    let lastStepCost: Double
    let contextTokens: Double
    let contextLimit: Double?
    let cacheReadRatio: Double

    var cacheSummary: String {
        if contextTokens == 0 { return "нет данных" }
        let ratio = Fmt.cachePercent(cacheReadRatio)
        guard let tokens = lastStepTokens else { return ratio }
        return "\(Fmt.cacheTokens(tokens.cache.read)) (\(ratio))"
    }

    var stepSummary: String { "Шаг ≈ \(Fmt.usd(lastStepCost)) · кеш \(cacheSummary)" }

    var stepDetails: String {
        var lines = ["Последний шаг ≈ \(Fmt.usd(lastStepCost))", "Чтение кеша: \(cacheSummary)"]
        lines.append("Процент — доля входных токенов из кеша, не скидка на стоимость")
        lines.append("Всего входных токенов: \(Int(contextTokens))")
        if let tokens = lastStepTokens { lines.append("Свежий вход: \(Fmt.tokens(tokens.input)) · запись кеша: \(Fmt.tokens(tokens.cache.write))") }
        if let charges = lastStepCharges { lines.append("Вход ≈ \(Fmt.usd(charges.inputUsd)), в том числе чтение кеша ≈ \(Fmt.usd(charges.cacheReadUsd))") }
        return lines.joined(separator: "\n")
    }
}

struct StepTokens: Decodable {
    struct Cache: Decodable { let read: Double; let write: Double }
    let input: Double
    let cache: Cache
}
struct StepCharges: Decodable { let inputUsd: Double; let cacheReadUsd: Double }

struct AlertInfo: Decodable {
    var accountingVersion: Int? = nil
    let at: Double
    let severity: String
    let title: String
    let subtitle: String?
    let body: String
}

enum NotifyMode: String, Codable, CaseIterable, Identifiable {
    case all, critical, off
    var id: String { rawValue }
    var title: String {
        switch self {
        case .all: return "Все"
        case .critical: return "Критичные"
        case .off: return "Выключены"
        }
    }
    var symbol: String {
        switch self {
        case .all: return "bell.badge"
        case .critical: return "exclamationmark.bell"
        case .off: return "bell.slash"
        }
    }
}

struct NotifySettings: Codable {
    var mode: NotifyMode
    static let `default` = NotifySettings(mode: .all)
}

struct Dismissed: Codable {
    var clearedBefore: Double
    var dismissed: [Double]
    static let empty = Dismissed(clearedBefore: 0, dismissed: [])
}

struct RunningMark: Decodable {
    var accountingVersion: Int? = nil
    let at: Double
}

struct SamplePoint: Identifiable {
    let id: Int
    let t: Date
    let spend: Double
}

enum Level: Equatable {
    case idle, ok, warn, critical

    var color: Color {
        switch self {
        case .idle: return .secondary
        case .ok: return .green
        case .warn: return .orange
        case .critical: return .red
        }
    }

    /// Спокойное состояние рисуем акцентным цветом системы, а не зелёным: зелёный нужен только для галочки.
    var tint: Color { self == .ok || self == .idle ? .accentColor : color }
}

func date(_ ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }

enum Fmt {
    private static let clockFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ru_RU")
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ru_RU")
        formatter.dateFormat = "d MMM, HH:mm"
        return formatter
    }()

    static func clock(_ value: Date) -> String { clockFormatter.string(from: value) }

    static func stamp(_ value: Date, now: Date) -> String {
        Calendar.current.isDate(value, inSameDayAs: now) ? clock(value) : dayFormatter.string(from: value)
    }

    static func usd(_ value: Double) -> String { String(format: "$%.2f", value) }

    static func usdWhole(_ value: Double) -> String { String(format: "$%.0f", value) }

    static func rate(_ value: Double) -> String { value >= 10 ? String(format: "$%.0f/ч", value) : String(format: "$%.1f/ч", value) }

    static func percent(_ value: Double) -> String { "\(Int(value.rounded()))%" }

    static func cachePercent(_ ratio: Double) -> String {
        if ratio == 0 { return "0%" }
        if ratio == 1 { return "100%" }
        let value = String(format: "%.1f", ratio * 100)
        if value == "100.0" { return ">99.9%" }
        if value == "0.0" { return "<0.1%" }
        return value.hasSuffix(".0") ? "\(value.dropLast(2))%" : "\(value)%"
    }

    static func cacheTokens(_ tokens: Double) -> String {
        if tokens < 1000 { return Fmt.tokens(tokens) }
        let value = String(format: "%.1f", tokens / 1000)
        return value.hasSuffix(".0") ? "\(value.dropLast(2))k" : "\(value)k"
    }

    static func tokens(_ value: Double) -> String {
        if value >= 1_000_000 { return String(format: "%.1fM", value / 1_000_000) }
        if value >= 1000 { return "\(Int((value / 1000).rounded()))k" }
        return "\(Int(value))"
    }

    static func duration(minutes: Double) -> String {
        let total = max(0, Int(minutes.rounded()))
        guard total >= 60 else { return "\(total) мин" }
        let hours = total / 60
        let rest = total % 60
        return rest == 0 ? "\(hours) ч" : "\(hours) ч \(rest) мин"
    }

    static func ago(_ value: Date, now: Date) -> String {
        let seconds = now.timeIntervalSince(value)
        return seconds < 60 ? "только что" : "\(duration(minutes: seconds / 60)) назад"
    }

    static func model(_ ref: ModelRef) -> String {
        let name = ref.id.hasPrefix("claude-") ? String(ref.id.dropFirst("claude-".count)) : ref.id
        guard let variant = ref.variant, variant != "default" else { return name }
        return "\(name) · \(variant)"
    }

    static func project(_ path: String) -> String { (path as NSString).lastPathComponent }

    static func clip(_ text: String, _ limit: Int) -> String {
        let single = text.replacingOccurrences(of: "\n", with: " ")
        return single.count > limit ? String(single.prefix(limit - 1)) + "…" : single
    }
}
