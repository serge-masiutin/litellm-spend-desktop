import SwiftUI

/// Верхний блок меню: состояние бюджета одним взглядом. Остальные пункты — обычные пункты меню.
struct MenuHeader: View {
    @ObservedObject var monitor: Monitor

    var body: some View {
        let verdict = monitor.verdict
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: verdict.symbol).foregroundStyle(verdict.level.color).font(.system(size: 17))
                Text(verdict.headline).font(.headline)
            }
            if let status = monitor.status, let left = monitor.left {
                HStack(alignment: .firstTextBaseline) {
                    Text(Fmt.usd(status.spend)).font(.system(size: 24, weight: .semibold, design: .rounded)).monospacedDigit().lineLimit(1)
                    Text("из \(Fmt.usdWhole(status.maxBudget))").foregroundStyle(.secondary).lineLimit(1)
                    Spacer()
                    Text("осталось \(Fmt.usdWhole(left))").foregroundStyle(.secondary).monospacedDigit().lineLimit(1).fixedSize()
                }
                BudgetBar(fraction: monitor.fraction, forecast: monitor.forecastFraction, level: verdict.level, height: 8)
            }
            Text(verdict.detail).font(.callout).foregroundStyle(.secondary)
            let active = monitor.activeSessions.count
            if active > 0 {
                Label("\(active) \(Fmt.plural(active, "активная сессия", "активные сессии", "активных сессий"))", systemImage: "bolt.horizontal.fill")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(width: 320, alignment: .leading)
    }
}
