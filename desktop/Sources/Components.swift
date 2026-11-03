import Charts
import SwiftUI

// MARK: - Движение с учётом «Уменьшить движение»

private struct MotionModifier<V: Equatable>: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let animation: Animation
    let value: V

    func body(content: Content) -> some View {
        content.animation(reduceMotion ? nil : animation, value: value)
    }
}

extension View {
    func motion<V: Equatable>(_ animation: Animation = .smooth(duration: 0.5), value: V) -> some View {
        modifier(MotionModifier(animation: animation, value: value))
    }
}

// MARK: - Карточка и заголовок раздела

struct Card<Content: View>: View {
    private let content: Content
    init(@ViewBuilder _ content: () -> Content) { self.content = content() }

    var body: some View {
        content
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color(nsColor: .controlBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.primary.opacity(0.07)))
    }
}

struct SectionTitle: View {
    let title: String
    var trailing: String?
    var help: String?

    var body: some View {
        HStack(spacing: 6) {
            Text(title).font(.headline)
            if let help {
                Image(systemName: "info.circle").foregroundStyle(.tertiary).help(help)
            }
            Spacer()
            if let trailing { Text(trailing).font(.subheadline).foregroundStyle(.secondary) }
        }
    }
}

// MARK: - Полоса бюджета

struct BudgetBar: View {
    let fraction: Double
    let forecast: Double?
    let level: Level
    var height: CGFloat = 10

    var body: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.09))
                if let forecast, forecast > fraction {
                    Capsule().fill(level.tint.opacity(0.28)).frame(width: width * min(1, forecast))
                }
                Capsule().fill(level.tint.gradient).frame(width: max(height, width * fraction))
            }
        }
        .frame(height: height)
        .motion(value: fraction)
        .accessibilityElement()
        .accessibilityLabel("Израсходовано \(Fmt.percent(fraction * 100))")
    }
}

// MARK: - Индикаторы

struct PulseDot: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expanded = false
    let color: Color

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 9, height: 9)
            .overlay(
                Circle()
                    .stroke(color, lineWidth: 1.5)
                    .scaleEffect(expanded ? 2.2 : 1)
                    .opacity(expanded ? 0 : 0.7)
            )
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeOut(duration: 1.6).repeatForever(autoreverses: false)) { expanded = true }
            }
            .accessibilityHidden(true)
    }
}

struct ContextMeter: View {
    let tokens: Double
    let scaleTop: Double
    let color: Color

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.09))
                    Capsule().fill(color.gradient).frame(width: max(5, geometry.size.width * min(1, tokens / scaleTop)))
                }
            }
            .frame(width: 88, height: 5)
            .motion(value: tokens)
            Text("Контекст \(Fmt.tokens(tokens))").font(.caption).foregroundStyle(.secondary).monospacedDigit()
        }
        .help("Полоса заполняется до \(Fmt.tokens(scaleTop)): дальше каждый шаг заметно дороже")
    }
}

// MARK: - График расхода

/// Образец линии в легенде рисуется тем же цветом и штрихом, что и на графике.
struct ChartLegendItem: View {
    let title: String
    let color: Color
    let style: StrokeStyle

    var body: some View {
        HStack(spacing: 5) {
            Path { path in
                path.move(to: CGPoint(x: 0, y: 1.5))
                path.addLine(to: CGPoint(x: 18, y: 1.5))
            }
            .stroke(color, style: style)
            .frame(width: 18, height: 3)
            Text(title)
        }
    }
}

struct SpendChart: View {
    @ObservedObject var monitor: Monitor

    var body: some View {
        if let status = monitor.status, !monitor.points.isEmpty, date(status.nextResetAt) > monitor.points[0].t {
            VStack(alignment: .leading, spacing: 6) {
                chart(status)
                HStack(spacing: 14) {
                    let tint = monitor.verdict.level.tint
                    ChartLegendItem(title: "Потрачено", color: tint, style: StrokeStyle(lineWidth: 2.2, lineCap: .round))
                    if let pace = monitor.dailyPace {
                        ChartLegendItem(title: monitor.status?.budget?.source == .manual ? "Прогноз по новым шагам после поправки" : "Прогноз при темпе за \(pace.windowLabel)", color: tint.opacity(0.75), style: StrokeStyle(lineWidth: 2, dash: [5, 4]))
                    }
                    ChartLegendItem(title: "Лимит", color: .red.opacity(0.55), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
        } else {
            HStack(spacing: 8) {
                Image(systemName: "chart.xyaxis.line")
                Text("График появится после нескольких запросов к модели")
            }
            .font(.callout)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, minHeight: 56)
        }
    }

    private func chart(_ status: KeyStatus) -> some View {
        let points = monitor.points
        let last = points[points.count - 1]
        let reset = date(status.nextResetAt)
        let tint = monitor.verdict.level.tint
        let lowest = points.map(\.spend).min() ?? 0
        let yMin = max(0, ((lowest - status.maxBudget * 0.08) / 10).rounded(.down) * 10)

        return Chart {
            ForEach(points) { point in
                AreaMark(x: .value("Время", point.t), yStart: .value("Низ", yMin), yEnd: .value("Расход", point.spend))
                    .foregroundStyle(LinearGradient(colors: [tint.opacity(0.32), tint.opacity(0.02)], startPoint: .top, endPoint: .bottom))
                    .interpolationMethod(.monotone)
                LineMark(x: .value("Время", point.t), y: .value("Расход", point.spend), series: .value("Ряд", "Расход"))
                    .foregroundStyle(tint)
                    .lineStyle(StrokeStyle(lineWidth: 2.2, lineCap: .round))
                    .interpolationMethod(.monotone)
            }
            if let pace = monitor.dailyPace {
                // Пауза после последнего ответа видна как ровный участок до текущего момента.
                if pace.now > last.t {
                    LineMark(x: .value("Время", pace.now), y: .value("Расход", last.spend), series: .value("Ряд", "Расход"))
                        .foregroundStyle(tint)
                        .lineStyle(StrokeStyle(lineWidth: 2.2, lineCap: .round))
                        .interpolationMethod(.monotone)
                }
                let endTime = pace.exhaustsAt ?? reset
                let endSpend = pace.exhaustsAt == nil ? pace.projectedSpend : status.maxBudget
                LineMark(x: .value("Время", pace.now), y: .value("Расход", pace.spend), series: .value("Ряд", "Прогноз"))
                    .foregroundStyle(tint.opacity(0.75))
                    .lineStyle(StrokeStyle(lineWidth: 2, dash: [5, 4]))
                LineMark(x: .value("Время", endTime), y: .value("Расход", endSpend), series: .value("Ряд", "Прогноз"))
                    .foregroundStyle(tint.opacity(0.75))
                    .lineStyle(StrokeStyle(lineWidth: 2, dash: [5, 4]))
                PointMark(x: .value("Время", endTime), y: .value("Расход", endSpend))
                    .foregroundStyle(tint)
                    .symbolSize(24)
                    .annotation(position: .top, alignment: .trailing, spacing: 3) {
                        Text(pace.exhaustsAt == nil ? "≈ \(Fmt.usdWhole(endSpend)) к сбросу" : "лимит в \(Fmt.clock(endTime))")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(tint)
                    }
            }
            RuleMark(y: .value("Лимит", status.maxBudget))
                .foregroundStyle(Color.red.opacity(0.55))
                .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                .annotation(position: .top, alignment: .leading, spacing: 2) {
                    Text("Лимит \(Fmt.usdWhole(status.maxBudget))").font(.caption2).foregroundStyle(.secondary)
                }
        }
        .chartXScale(domain: points[0].t...reset)
        .chartYScale(domain: yMin...(status.maxBudget * 1.08))
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                AxisGridLine().foregroundStyle(Color.primary.opacity(0.08))
                AxisValueLabel(format: .dateTime.hour().minute())
            }
        }
        .chartYAxis {
            AxisMarks(values: .automatic(desiredCount: 3)) { value in
                AxisGridLine().foregroundStyle(Color.primary.opacity(0.08))
                AxisValueLabel {
                    if let number = value.as(Double.self) { Text(Fmt.usdWhole(number)) }
                }
            }
        }
        .frame(height: 150)
        .accessibilityLabel("График расхода ключа с последнего сброса до следующего")
    }
}
