import AppKit
import SwiftUI

/// Режим проверки внешнего вида без доступа к экрану:
/// OpenCodeSpend --snapshot <каталог-вывода> [--data-dir <каталог-данных>]
/// Рисует окно, шапку меню и значок строки меню в светлой и тёмной теме.
enum Snapshot {
    static func run(outputDir: String, dataDir: String?) {
        let output = URL(fileURLWithPath: outputDir)
        do { try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true) } catch { fatalError("\(error)") }

        let monitor = dataDir.map { Monitor(dir: URL(fileURLWithPath: $0)) } ?? Monitor()
        monitor.reload()

        for (name, appearance) in [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)] {
            let scheme: ColorScheme = name == "dark" ? .dark : .light
            let window = MainContent(monitor: monitor, actions: .none)
                .padding(20)
                .frame(width: 600)
                .background(Color(nsColor: .windowBackgroundColor))
                .environment(\.colorScheme, scheme)
            write(window, appearance, output.appendingPathComponent("window-\(name).png"), width: 600)

            let correction = DailyBudgetEditor(monitor: monitor)
                .background(Color(nsColor: .windowBackgroundColor))
                .environment(\.colorScheme, scheme)
            write(correction, appearance, output.appendingPathComponent("daily-correction-\(name).png"), width: 460)

            for width in [520, 600] {
                if let plan = monitor.planningBudget {
                    let month = MonthlyBudgetCard(status: monitor.status, plan: plan, resetIsPast: monitor.resetIsPast, now: monitor.now)
                        .padding(20)
                        .frame(width: CGFloat(width))
                        .background(Color(nsColor: .windowBackgroundColor))
                        .environment(\.colorScheme, scheme)
                    write(month, appearance, output.appendingPathComponent("monthly-\(width)-\(name).png"), width: CGFloat(width))
                }
                let settings = PanelSettings(monitor: monitor, actions: .none)
                    .padding(20)
                    .frame(width: CGFloat(width))
                    .background(Color(nsColor: .windowBackgroundColor))
                    .environment(\.colorScheme, scheme)
                write(settings, appearance, output.appendingPathComponent("settings-\(width)-\(name).png"), width: CGFloat(width))
            }

            let limits = ThresholdsView(store: ThresholdStore())
                .frame(width: 480, height: 640)
                .background(Color(nsColor: .windowBackgroundColor))
                .environment(\.colorScheme, scheme)
            write(limits, appearance, output.appendingPathComponent("thresholds-\(name).png"), width: 480)

            let header = MenuHeader(monitor: monitor)
                .background(Color(nsColor: .windowBackgroundColor))
                .environment(\.colorScheme, scheme)
            write(header, appearance, output.appendingPathComponent("menu-\(name).png"), width: 320)

            let strip = HStack(spacing: 6) {
                Image(nsImage: StatusIcon.image(fraction: monitor.status == nil ? nil : monitor.fraction, level: monitor.verdict.level))
                    .renderingMode(monitor.verdict.level == .warn || monitor.verdict.level == .critical ? .original : .template)
                Text(label(monitor)).font(.system(size: 13, weight: .medium).monospacedDigit())
            }
            .foregroundStyle(name == "dark" ? Color.white : Color.black)
            .padding(.horizontal, 12)
            .padding(.vertical, 4)
            .background(name == "dark" ? Color(white: 0.2) : Color(red: 0.35, green: 0.5, blue: 0.75))
            .environment(\.colorScheme, scheme)
            write(strip, appearance, output.appendingPathComponent("bar-\(name).png"), width: nil)
        }
    }

    static func label(_ monitor: Monitor) -> String {
        guard let status = monitor.status, let percent = monitor.percent, !monitor.resetIsPast else { return "" }
        return "\(Fmt.usdWhole(status.spend)) · \(Fmt.percent(percent))"
    }

    private static func write<V: View>(_ view: V, _ appearance: NSAppearance.Name, _ url: URL, width: CGFloat?) {
        let host = NSHostingView(rootView: view)
        host.appearance = NSAppearance(named: appearance)
        let fitting = host.fittingSize
        host.frame = NSRect(x: 0, y: 0, width: width ?? fitting.width, height: fitting.height)
        host.layoutSubtreeIfNeeded()
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { fatalError("no bitmap for \(url.lastPathComponent)") }
        rep.size = host.bounds.size
        host.cacheDisplay(in: host.bounds, to: rep)
        guard let data = rep.representation(using: .png, properties: [:]) else { fatalError("png failed for \(url.lastPathComponent)") }
        do { try data.write(to: url) } catch { fatalError("\(error)") }
    }
}
