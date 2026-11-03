import Foundation
import AppKit

enum AppSelfTest {
    static func run() throws {
        let manager = FileManager.default
        let temporary = manager.temporaryDirectory.appendingPathComponent("litellm-desktop-test-" + UUID().uuidString)
        try manager.createDirectory(at: temporary, withIntermediateDirectories: true)
        defer { try? manager.removeItem(at: temporary) }
        let environment = AppEnvironment(config: temporary.appendingPathComponent("profile/config.json"), resources: Bundle.main.resourceURL!)
        try environment.prepare()
        let original = try Data(contentsOf: environment.config)
        try environment.prepare()
        try require(try Data(contentsOf: environment.config) == original, "prepare перезаписал существующий конфиг")
        let mode = try manager.attributesOfItem(atPath: environment.config.path)[.posixPermissions] as! NSNumber
        try require(mode.intValue == 0o600, "Небезопасные права config.json")
        let keyFile = temporary.appendingPathComponent("secrets/key")
        let store = ConnectionStore(environment: environment, keyFile: keyFile)
        store.load()
        try require(store.baseURL == "https://litellm.example.com", "Не прочитан адрес из defaults")
        store.baseURL = "https://user:secret@example.com"
        store.save()
        try require(try Data(contentsOf: environment.config) == original, "Сохранён адрес с credentials")
        store.baseURL = "https://gateway.example.org/"
        store.save()
        let root = try environment.root()
        let litellm = root["litellm"] as! [String: Any]
        try require(litellm["baseUrl"] as! String == "https://gateway.example.org", "Не сохранён endpoint")
        try require(litellm["keyFile"] as! String == "~/.config/litellm-spend/key", "Пустое поле изменило ключ")
        try require((root["keyBudget"] as! [String: Any])["resetHourUtc"] as! Int == 0, "Изменён час сброса")
        store.apiKey = "fixture-desktop-key"
        store.save()
        try require(try String(contentsOf: keyFile, encoding: .utf8) == "fixture-desktop-key", "Не сохранён новый ключ")
        let keyMode = try manager.attributesOfItem(atPath: keyFile.path)[.posixPermissions] as! NSNumber
        try require(keyMode.intValue == 0o600, "Небезопасные права ключа")
        store.load()
        try require(store.apiKey.isEmpty, "Ключ оказался в поле формы")
        var updated = root
        updated["storage"] = ["dir": temporary.appendingPathComponent("data").path]
        try JSONSerialization.data(withJSONObject: updated).write(to: environment.config)
        try require(try environment.storage(env: [:]).path == temporary.appendingPathComponent("data").path, "Панель не использует storage.dir")
        try require(try environment.storage(env: ["LITELLM_SPEND_DIR": temporary.path]).path == temporary.path, "Не применяется переопределение storage.dir")
        let thresholds = ThresholdStore(url: environment.config, defaultsURL: environment.defaults)
        try require(thresholds.error == nil, "Пороги не читают общий конфиг")
        let plan = BudgetPlanSettings(config: environment.config)
        plan.load()
        try require(plan.monthly.isEmpty, "Личный месячный бюджет задан без пользователя")
        var legacyRoot = try environment.root()
        legacyRoot["planningBudget"] = ["dailyUsd": 300, "monthlyUsd": 4000]
        try JSONSerialization.data(withJSONObject: legacyRoot).write(to: environment.config)
        plan.load()
        try require(Double(plan.monthly) == 4000, "Старый конфиг с месячным бюджетом не прочитан")
        plan.monthly = "4000"
        plan.save()
        let savedRoot = try environment.root()
        let savedPlan = savedRoot["planningBudget"] as! [String: Double]
        try require(savedPlan == ["monthlyUsd": 4000], "Месячный бюджет не сохранён без дневного лимита")
        try require((savedRoot["keyBudget"] as! [String: Any])["resetHourUtc"] as! Int == 0, "Личные лимиты изменили UTC-сброс")
        plan.monthly = "0"
        plan.save()
        try require((try environment.root()["planningBudget"] as! [String: Double]) == ["monthlyUsd": 4000], "Некорректный лимит записан в конфиг")
        plan.load()
        try require(Double(plan.monthly) == 4000, "Конфиг без дневного лимита не прочитан")
        legacyRoot["planningBudget"] = ["monthlyUsd": true]
        try JSONSerialization.data(withJSONObject: legacyRoot).write(to: environment.config)
        plan.load()
        try require(!plan.message.isEmpty, "Логическое значение принято как месячный бюджет")
        try JSONSerialization.data(withJSONObject: savedRoot).write(to: environment.config)
        try require(Fmt.cachePercent(0.99913) != "100%", "Неполный кеш округляется до 100%")
        let dataDirectory = temporary.appendingPathComponent("data")
        try manager.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
        let now = Date().timeIntervalSince1970 * 1000
        var status: [String: Any] = [
            "updatedAt": now, "spend": -184.50577, "maxBudget": 300,
            "periodStartAt": now - 1000, "nextResetAt": now + 3600000,
            "forecast": NSNull(), "thresholdsPercent": [50, 75, 90],
            "contextThresholdsTokens": [150000, 250000, 400000], "activeWithinMinutes": 10,
            "cacheMinContextTokens": 100000, "cacheMinReadRatio": 0.5,
        ]
        let statusFile = dataDirectory.appendingPathComponent("status.json")
        try JSONSerialization.data(withJSONObject: status).write(to: statusFile)
        let budgetMonitor = Monitor(dir: dataDirectory, config: environment.config)
        budgetMonitor.reload()
        try require(budgetMonitor.planningBudget!.monthlyUsd == 4000, "Месячный бюджет не читается без нового ответа модели")
        plan.monthly = "3500"
        plan.save()
        budgetMonitor.reload()
        try require(budgetMonitor.planningBudget!.monthlyUsd == 3500, "Изменение месячного бюджета ждёт ответа модели")
        try require(budgetMonitor.status!.spend == -184.50577, "Потеряно отрицательное показание шлюза")
        try require(budgetMonitor.percent == nil && budgetMonitor.left == nil && budgetMonitor.projectedLeft == nil, "Вычислен выдуманный остаток из отрицательного расхода")
        try require(budgetMonitor.verdict.headline == "Аномалия бюджета LiteLLM", "Отрицательный расход ошибочно показан как ожидание сброса")
        status["spend"] = 5
        status["planningBudget"] = ["monthlyUsd": 4000]
        status["monthlyEstimate"] = ["observedSpend": 25, "observedDays": 2, "elapsedDays": 5, "daysInMonth": 30, "firstSampleAt": now - 86400000]
        try JSONSerialization.data(withJSONObject: status).write(to: statusFile)
        budgetMonitor.reload()
        try require(budgetMonitor.left == 295, "Остаток не рассчитан по лимиту ключа после корректного показания")
        try require(budgetMonitor.status!.planningBudget!.monthlyUsd == 4000 && budgetMonitor.status!.monthlyEstimate!.observedSpend == 25, "Месячный статус не прочитан")
        try require(budgetMonitor.status!.monthlyEstimate!.days == nil, "Старый месячный статус без разбивки перестал читаться")
        status["monthlyEstimate"] = ["observedSpend": 25, "observedDays": 2, "elapsedDays": 5, "daysInMonth": 30, "firstSampleAt": now - 86400000, "days": [["day": 2, "spend": 0], ["day": 5, "spend": 25]]] as [String: Any]
        try JSONSerialization.data(withJSONObject: status).write(to: statusFile)
        budgetMonitor.reload()
        let monthDays = budgetMonitor.status!.monthlyEstimate!.days!
        try require(monthDays.count == 2 && monthDays[0].spend == 0 && monthDays[1].day == 5, "График теряет нулевое показание или заполняет пропуски")
        let samplesDirectory = dataDirectory.appendingPathComponent("samples")
        try manager.createDirectory(at: samplesDirectory, withIntermediateDirectories: true)
        let periodStart = status["periodStartAt"] as! Double
        // До сброса на нечётном индексе расход растёт до $400, после него — заново от $1 до $98.
        let manyReadings = (0..<400).map { index in "{\"t\":\(periodStart + Double(index)),\"spend\":\(index <= 300 ? 100 + index : index - 301)}" }
        try manyReadings.joined(separator: "\n").write(to: samplesDirectory.appendingPathComponent(String(format: "%.0f.jsonl", periodStart)), atomically: true, encoding: .utf8)
        budgetMonitor.reload()
        try require(budgetMonitor.points.count < 400 && budgetMonitor.points.contains { $0.spend == 0 }, "Прореживание графика скрыло сброс показаний")
        try require(budgetMonitor.points.last!.spend == 98, "Огибающая не перезапущена после сброса")
        try manager.removeItem(at: samplesDirectory)
        status["budget"] = ["source": "manual", "gatewaySpend": -184.50577, "observedSteps": 2, "unpricedSteps": 0, "firstStepAt": now - 1000, "correctedAt": now - 500] as [String: Any]
        status["budgetSamples"] = [["t": now - 500, "spend": 10], ["t": now, "spend": 12]]
        status["spend"] = 12
        try JSONSerialization.data(withJSONObject: status).write(to: statusFile)
        budgetMonitor.reload()
        try require(budgetMonitor.status!.budget!.source == .manual && budgetMonitor.status!.budget!.gatewaySpend == -184.50577, "Источник и сырое показание локального бюджета потеряны")
        try require(budgetMonitor.points.map(\.spend) == [10, 12] && budgetMonitor.left == 288, "Локальный график читает серверные точки вместо исправленного расхода")
        try require(budgetMonitor.dailyPace != nil, "Темп недоступен для локального бюджета")
        let correctionDay = ISO8601DateFormatter().string(from: Date()).prefix(10)
        try environment.correctDailyBudget(day: String(correctionDay), amount: 25.5, storage: dataDirectory)
        let correctionNames = try manager.contentsOfDirectory(atPath: dataDirectory.appendingPathComponent("budget-corrections").path)
        try require(correctionNames.count == 1, "Нативный редактор не вызвал общее ядро поправок")
        let correctionURL = dataDirectory.appendingPathComponent("budget-corrections/" + correctionNames[0])
        let correction = try JSONSerialization.jsonObject(with: Data(contentsOf: correctionURL)) as! [String: Any]
        try require(correction["amount"] as! Double == 25.5, "Редактор записал другую сумму поправки")
        status["budget"] = ["source": "local", "gatewaySpend": -184.50577, "observedSteps": 0, "unpricedSteps": 0, "firstStepAt": NSNull(), "correctedAt": NSNull()] as [String: Any]
        status["budgetSamples"] = [] as [[String: Double]]
        status["spend"] = 0
        try JSONSerialization.data(withJSONObject: status).write(to: statusFile)
        budgetMonitor.reload()
        try require(budgetMonitor.left == nil && budgetMonitor.percent == nil && budgetMonitor.dailyPace == nil, "Пустая локальная история выдана за нулевой расход")
        try require(budgetMonitor.verdict.headline == "Нет локальной оценки за день", "Без истории ошибочно обещан доступный бюджет")
        status.removeValue(forKey: "budget")
        status.removeValue(forKey: "budgetSamples")
        let iso = ISO8601DateFormatter()
        let octoberStart = iso.date(from: "2026-10-01T00:00:00Z")!
        let novemberStart = iso.date(from: "2026-11-01T00:00:00Z")!
        let october = MonthlyCalendar(now: iso.date(from: "2026-10-28T23:59:59Z")!)
        try require(october.start == octoberStart && october.end == novemberStart && october.daysInMonth == 31, "Месяц зависит от начала сбора данных")
        try require(october.label == "1–31 октября 2026", "На карточке не указан полный календарный месяц")
        let nextDay = MonthlyCalendar(now: iso.date(from: "2026-10-29T00:00:00Z")!)
        try require(october.elapsedDays == 28 && nextDay.elapsedDays == 29, "Календарный день не обновляется на UTC-границе")
        var octoberStatus = status
        octoberStatus["periodStartAt"] = iso.date(from: "2026-10-28T00:00:00Z")!.timeIntervalSince1970 * 1000
        let decodedOctober = try JSONDecoder().decode(KeyStatus.self, from: JSONSerialization.data(withJSONObject: octoberStatus))
        try require(nextDay.estimate(from: decodedOctober)?.observedSpend == 25, "Пропуск ответов удаляет оценку текущего месяца")
        let november = MonthlyCalendar(now: novemberStart)
        try require(november.daysInMonth == 30 && november.elapsedDays == 1 && november.estimate(from: decodedOctober) == nil, "Прошлый месяц показан как текущий")
        let february = MonthlyCalendar(now: iso.date(from: "2028-02-15T12:00:00Z")!)
        try require(february.daysInMonth == 29 && february.label == "1–29 февраля 2028", "Високосный месяц имеет неверные границы")
        let midMonth = MonthlyCalendar(now: iso.date(from: "2026-11-11T12:00:00Z")!)
        let heavy = MonthlyPace(days: [.init(day: 1, spend: 300), .init(day: 2, spend: 300), .init(day: 5, spend: 100), .init(day: 11, spend: 80)],
                                budget: 4000, keyLimit: 300, calendar: midMonth)
        try require(heavy.daysLeft == 20 && heavy.remaining == 3220 && heavy.todaySpend == 80, "Остаток месяца посчитан неверно")
        try require(heavy.dailyAllowance == 3300.0 / 20 && !heavy.limitedByKey && heavy.fullDays == 10, "Норма не пересчитана из остатка на начало дня")
        try require(!heavy.todayOverPlan, "Сегодняшний расход ниже нормы помечен как превышение")
        let overspent = MonthlyPace(days: [.init(day: 10, spend: 4090), .init(day: 11, spend: 10)], budget: 4000, keyLimit: 300, calendar: midMonth)
        try require(overspent.remaining == -100 && overspent.plannedDaily == 0 && overspent.fullDays == 0 && overspent.todayOverPlan, "Перерасход скрыт")
        let heavyToday = MonthlyPace(days: [.init(day: 11, spend: 290)], budget: 4000, keyLimit: 300, calendar: midMonth)
        try require(heavyToday.plannedDaily == 200 && heavyToday.todayOverPlan, "Тяжёлый сегодняшний день не отмечен или сдвинул норму в течение дня")
        let exhaustedToday = MonthlyPace(days: [.init(day: 10, spend: 3910), .init(day: 11, spend: 250)], budget: 4000, keyLimit: 300, calendar: midMonth)
        try require(exhaustedToday.exhausted && exhaustedToday.plannedDaily == 0, "После исчерпания бюджета сохраняется ненулевая норма")
        let lastDay = MonthlyPace(days: [.init(day: 30, spend: 50)], budget: 4000, keyLimit: 300, calendar: MonthlyCalendar(now: iso.date(from: "2026-11-30T08:00:00Z")!))
        try require(lastDay.daysLeft == 1 && lastDay.limitedByKey && lastDay.plannedDaily == 300, "Норма превышает лимит ключа")
        try require(DailyPace.envelope([1.9, 2, 0, 3, 2.5, 5, -1, 4]) == [1.9, 2, 0, 3, 3, 5, -1, 4], "Старое показание параллельного ответа снижает расход")
        let dayStart = iso.date(from: "2026-11-11T00:00:00Z")!
        let dayReset = iso.date(from: "2026-11-12T00:00:00Z")!
        func readings(_ values: [(minute: Double, spend: Double)]) -> [SamplePoint] {
            values.enumerated().map { SamplePoint(id: $0.offset, t: dayStart.addingTimeInterval($0.element.minute * 60), spend: $0.element.spend) }
        }
        func pace(_ values: [(minute: Double, spend: Double)], at minute: Double) -> DailyPace? {
            DailyPace(points: readings(values), maxBudget: 300, periodStart: dayStart, reset: dayReset, now: dayStart.addingTimeInterval(minute * 60))
        }
        let idle = pace([(600, 20), (650, 40)], at: 800)!
        try require(idle.ratePerHour == 0 && idle.projectedSpend == 40 && idle.exhaustsAt == nil, "Пауза не снижает темп до нуля")
        let burst = pace([(600, 20), (1200, 21), (1205, 26)], at: 1210)!
        try require(abs(burst.ratePerHour - 6) < 1e-9, "Начало работы после паузы не даёт оценку темпа")
        let young = pace([(5, 2), (20, 10)], at: 20)!
        try require(abs(young.ratePerHour - 24) < 1e-9, "Темп в начале периода не считается от начала периода")
        let early = pace([(1, 2), (2, 5)], at: 2)!
        try require(abs(early.ratePerHour - 18) < 1e-9, "Первые минуты после сброса дают завышенный темп")
        let gatewayReset = pace([(1300, 1.9), (1301, 2), (1302, 0), (1330, 5)], at: 1340)!
        try require(abs(gatewayReset.ratePerHour - 5) < 1e-9, "Сброс на шлюзе внутри окна исказил темп")
        let heavyHour = pace([(1200, 150), (1320, 250)], at: 1320)!
        try require(abs(heavyHour.ratePerHour - 100) < 1e-9 && heavyHour.exhaustsAt == dayStart.addingTimeInterval(1350 * 60), "Время исчерпания лимита посчитано неверно")
        try require(abs(heavyHour.allowancePerHour - 25) < 1e-9, "Предельный темп посчитан неверно")
        try require(pace([(600, 10), (700, -5)], at: 710) == nil && pace([(600, 10)], at: 1440) == nil, "Темп показан при аномалии или после сброса")
        func session(_ id: String, cost: Double, ancestors: [String]) -> SessionInfo {
            SessionInfo(id: id, title: id, directory: "/test", ancestorIds: ancestors, ancestryComplete: true,
                        model: ModelRef(providerID: "litellm", id: "test", variant: nil), cost: cost, steps: 1,
                        lastStepAt: now, lastStepCost: cost, contextTokens: 100, contextLimit: nil, cacheReadRatio: 0)
        }
        let parent = session("parent", cost: 52.52, ancestors: [])
        let child = session("child", cost: 1, ancestors: ["parent"])
        let grandchild = session("grandchild", cost: 1.75, ancestors: ["child", "parent"])
        let unrelated = session("unrelated", cost: 100, ancestors: [])
        let delegator = session("delegator", cost: 0, ancestors: [])
        budgetMonitor.sessions = [parent, child, grandchild, unrelated, delegator, session("worker", cost: 0.02, ancestors: ["delegator"])]
        let total = budgetMonitor.sessionTotal(parent)
        try require(abs(total.cost - 55.27) < 0.000001 && total.subagentsCost == 2.75 && total.descendants == 2, "Общая стоимость не включает всех потомков ровно один раз")
        let childTotal = budgetMonitor.sessionTotal(child)
        try require(childTotal.cost == 2.75 && childTotal.subagentsCost == 1.75, "Вложенная сессия теряет расходы своих сабагентов")
        let standaloneTotal = budgetMonitor.sessionTotal(unrelated)
        try require(standaloneTotal.cost == 100 && standaloneTotal.subagentsCost == 0 && standaloneTotal.descendants == 0, "Сессии без сабагентов получили чужие расходы")
        budgetMonitor.sessions = [delegator, session("worker", cost: 0.02, ancestors: ["delegator"])]
        try require(budgetMonitor.recentSessions.contains { $0.id == delegator.id }, "Сессия с расходами только сабагентов скрыта из недавних")
        _ = NSApplication.shared
        let delegate = try AppDelegate(environment: environment)
        let menu = NSMenu()
        delegate.configureMenu(menu)
        let commands = menu.items.filter { $0.action != nil }.map(\.title)
        try require(commands == ["Открыть панель", "Открыть OpenCode", "Выйти"], "В маленькое меню вернулись настройки")
        print("Desktop self-test: OK (config, permissions, secure key, settings, storage, thresholds, cache)")
    }

    private static func require(_ condition: Bool, _ message: String) throws {
        if !condition { throw NSError(domain: "SelfTest", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }
}
