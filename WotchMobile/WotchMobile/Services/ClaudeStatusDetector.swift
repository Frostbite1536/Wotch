import Foundation
import Combine

/// Claude Code status detector — direct port of ClaudeStatusDetector from main.js.
///
/// Feeds raw terminal output through ANSI stripping and pattern matching
/// to detect Claude's current activity state. Uses the same 6-state machine
/// and priority-based detection as the desktop app.
final class ClaudeStatusDetector: ObservableObject {
    /// Per-connection tracking state
    private struct TabState {
        var state: ClaudeState = .idle
        var description: String = ""
        var buffer: String = ""           // rolling buffer of recent clean text (~2000 chars)
        var lastActivity: Date = .distantPast
        var claudeActive: Bool = false
        var recentFiles: [String] = []
    }

    private var tabs: [UUID: TabState] = [:]

    /// Published aggregate status (most interesting across all connections)
    @Published var aggregateStatus: ClaudeStatusInfo = .idle

    /// Per-connection status
    @Published var perTabStatus: [UUID: ClaudeStatusInfo] = [:]

    private var broadcastTimer: Timer?
    private var idleCheckTimer: Timer?

    init() {
        // Idle timeout check — matches desktop's 2s interval
        // If no output for 5s while thinking/working → transition to idle
        idleCheckTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.checkIdleTimeouts()
        }
    }

    deinit {
        idleCheckTimer?.invalidate()
        broadcastTimer?.invalidate()
    }

    // MARK: - Tab management

    func addTab(_ tabId: UUID) {
        tabs[tabId] = TabState()
    }

    func removeTab(_ tabId: UUID) {
        tabs.removeValue(forKey: tabId)
        perTabStatus.removeValue(forKey: tabId)
        updateAggregate()
    }

    // MARK: - Feed data (main detection entry point)

    /// Feed raw terminal output for analysis.
    /// Direct port of ClaudeStatusDetector.feed() from main.js
    func feed(tabId: UUID, rawData: String) {
        guard var tab = tabs[tabId] else { return }

        let clean = stripAnsi(rawData)
        tab.lastActivity = Date()

        // Rolling buffer — keep last ~2000 chars
        tab.buffer += clean
        if tab.buffer.count > 2000 {
            tab.buffer = String(tab.buffer.suffix(2000))
        }

        // ── Detect if Claude Code session is active ──
        if !tab.claudeActive {
            if clean.range(of: #"claude\s"#, options: .regularExpression, range: nil, locale: nil) != nil ||
               clean.contains("╭─") ||
               clean.range(of: "Claude Code", options: .caseInsensitive) != nil ||
               clean.range(of: "claude.ai", options: .caseInsensitive) != nil {
                tab.claudeActive = true
            }
        }

        if !tab.claudeActive {
            tab.state = .idle
            tab.description = ""
            tabs[tabId] = tab
            scheduleBroadcast()
            return
        }

        let prevState = tab.state
        let prevDesc = tab.description

        // ── Pattern matching — same priority order as desktop ──

        // Check for spinner characters (braille spinners)
        let hasSpinner = rawData.range(of: #"[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]"#, options: .regularExpression) != nil

        // 1. Error
        if matchesAny(clean, patterns: Self.errorPatterns) {
            tab.state = .error
            tab.description = extractDescription(from: clean, fallback: "Error")
        }
        // 2. Done
        else if matchesAny(clean, patterns: Self.donePatterns) {
            tab.state = .done
            tab.description = extractDescription(from: clean, fallback: "Done")
        }
        // 3. Waiting for user
        else if matchesAny(clean, patterns: Self.waitingPatterns) {
            tab.state = .waiting
            tab.description = "Waiting for input"
        }
        // 4. Tool use (file operations, commands)
        else if let toolMatch = firstMatch(clean, patterns: Self.toolUsePatterns) {
            tab.state = .working
            let target = toolMatch.trimmingCharacters(in: .whitespaces)
            let shortTarget = target.contains("/") ? (target.split(separator: "/").last.map(String.init) ?? target) : target
            tab.description = shortTarget.isEmpty ? "Working..." : "Working on \(String(shortTarget.prefix(40)))"
            if !shortTarget.isEmpty && !tab.recentFiles.contains(shortTarget) {
                tab.recentFiles.append(shortTarget)
                if tab.recentFiles.count > 5 { tab.recentFiles.removeFirst() }
            }
        }
        // 5. File paths (secondary working indicator)
        else if let filePath = firstMatch(clean, patterns: Self.filePathPatterns) {
            let fileName = filePath.split(separator: "/").last.map(String.init) ?? filePath
            if fileName.count > 2 {
                tab.state = .working
                tab.description = "Touching \(fileName)"
                if !tab.recentFiles.contains(fileName) {
                    tab.recentFiles.append(fileName)
                    if tab.recentFiles.count > 5 { tab.recentFiles.removeFirst() }
                }
            }
        }
        // 6. Thinking / spinner
        else if hasSpinner || matchesAny(clean, patterns: Self.thinkingPatterns) {
            tab.state = .thinking
            tab.description = tab.description.isEmpty ? "Thinking..." : tab.description
        }
        // 7. Shell prompt → idle
        else if matchesAny(clean, patterns: Self.promptPatterns) {
            tab.state = .idle
            tab.description = tab.claudeActive ? "Ready" : ""
        }

        // Richer descriptions for multi-file edits
        if tab.state == .working && tab.recentFiles.count > 1 {
            let count = tab.recentFiles.count
            let latest = tab.recentFiles.last ?? ""
            tab.description = "Editing \(count) files (\(latest))"
        }

        tabs[tabId] = tab

        if tab.state != prevState || tab.description != prevDesc {
            scheduleBroadcast()
        }
    }

    // MARK: - ANSI stripping (port of stripAnsi from main.js)

    private func stripAnsi(_ str: String) -> String {
        // Remove ANSI escape sequences
        var result = str.replacingOccurrences(
            of: #"[\u{001B}\u{009B}][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]"#,
            with: "",
            options: .regularExpression
        )
        // Remove other control characters (but keep newlines and tabs)
        result = result.replacingOccurrences(
            of: #"[\x00-\x08\x0B\x0C\x0E-\x1F]"#,
            with: "",
            options: .regularExpression
        )
        return result
    }

    // MARK: - Pattern definitions (ported from main.js)

    /// Error patterns: ✗, ✘, ×, Error, Failed, etc.
    private static let errorPatterns: [String] = [
        #"[✗✘×]\s*(.{0,60})"#,
        #"(?i)\b(?:Error|Failed|Failure)\b"#,
        #"(?i)command failed"#,
        #"(?i)permission denied"#,
        #"(?i)not found"#,
    ]

    /// Done patterns: ✓, ✔, Done, Complete, etc.
    private static let donePatterns: [String] = [
        #"[✓✔]\s*(.{0,60})"#,
        #"(?i)\b(?:Done|Complete|Finished|Success|Applied)\b"#,
        #"(?i)changes applied"#,
        #"(?i)wrote \d+ file"#,
        #"(?i)updated \d+ file"#,
    ]

    /// Waiting patterns: questions, prompts for user input
    private static let waitingPatterns: [String] = [
        #"\?\s*$"#,
        #"(?i)would you like"#,
        #"(?i)do you want"#,
        #"(?i)shall I"#,
        #"(?i)should I"#,
        #"(?i)choose|select|pick"#,
        #"\(y/n\)"#,
        #"\[Y/n\]"#,
        #"(?i)approve|accept|reject|deny"#,
    ]

    /// Tool use patterns: Read, Write, Edit, Run, etc.
    private static let toolUsePatterns: [String] = [
        #"(?i)(?:Read|Reading)\s+(.{1,60})"#,
        #"(?i)(?:Write|Writing)\s+(.{1,60})"#,
        #"(?i)(?:Edit|Editing)\s+(.{1,60})"#,
        #"(?i)(?:Update|Updating)\s+(.{1,60})"#,
        #"(?i)(?:Create|Creating)\s+(.{1,60})"#,
        #"(?i)(?:Delete|Deleting)\s+(.{1,60})"#,
        #"(?i)(?:Search|Searching)\s+(.{1,60})"#,
        #"(?i)(?:Replace|Replacing)\s+(.{1,60})"#,
        #"(?i)(?:Run|Running|Execute|Executing)\s+(.{1,60})"#,
        #"(?i)(?:Install|Installing)\s+(.{1,60})"#,
        #"(?i)(?:Compile|Compiling|Build|Building)\s+(.{1,60})"#,
        #"(?i)(?:Test|Testing)\s+(.{1,60})"#,
    ]

    /// File path patterns
    private static let filePathPatterns: [String] = [
        #"([a-zA-Z0-9_\-/.]+\.(?:ts|js|py|rs|go|jsx|tsx|css|html|json|toml|yaml|yml|md|txt|c|cpp|h|java|rb|php|swift|kt|sh|sql))\b"#,
    ]

    /// Thinking patterns
    private static let thinkingPatterns: [String] = [
        #"(?i)thinking"#,
        #"(?i)processing"#,
        #"(?i)analyzing"#,
        #"(?i)understanding"#,
        #"(?i)planning"#,
        #"(?i)reasoning"#,
    ]

    /// Shell prompt patterns (back to idle)
    private static let promptPatterns: [String] = [
        #"[❯➜→▶\$#%]\s*$"#,
        #"(?m)^\s*\$\s*$"#,
    ]

    // MARK: - Pattern matching helpers

    private func matchesAny(_ text: String, patterns: [String]) -> Bool {
        for pattern in patterns {
            if text.range(of: pattern, options: .regularExpression) != nil {
                return true
            }
        }
        return false
    }

    private func firstMatch(_ text: String, patterns: [String]) -> String? {
        for pattern in patterns {
            if let range = text.range(of: pattern, options: .regularExpression) {
                let match = String(text[range])
                // Try to extract capture group content (the file/target name)
                if let regex = try? NSRegularExpression(pattern: pattern),
                   let nsMatch = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
                   nsMatch.numberOfRanges > 1,
                   let captureRange = Range(nsMatch.range(at: 1), in: text) {
                    return String(text[captureRange])
                }
                return match
            }
        }
        return nil
    }

    private func extractDescription(from text: String, fallback: String) -> String {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: " ", maxSplits: 7)
            .joined(separator: " ")
        return words.count > 3 ? String(words.prefix(50)) : fallback
    }

    // MARK: - Idle timeout (port of desktop's idleCheckInterval)

    private func checkIdleTimeouts() {
        let now = Date()
        var changed = false

        for (tabId, var tab) in tabs {
            // If thinking/working with no output for 5s → idle
            if (tab.state == .thinking || tab.state == .working) &&
                now.timeIntervalSince(tab.lastActivity) > 5.0 {
                tab.state = .idle
                tab.description = "Ready"
                tabs[tabId] = tab
                changed = true
            }
            // Clear "done" after 8s
            if tab.state == .done && now.timeIntervalSince(tab.lastActivity) > 8.0 {
                tab.state = .idle
                tab.description = "Ready"
                tabs[tabId] = tab
                changed = true
            }
            // Clear "error" after 10s
            if tab.state == .error && now.timeIntervalSince(tab.lastActivity) > 10.0 {
                tab.state = .idle
                tab.description = "Ready"
                tabs[tabId] = tab
                changed = true
            }
        }

        if changed { broadcastNow() }
    }

    // MARK: - Broadcast (debounced at 150ms, matching desktop)

    private func scheduleBroadcast() {
        guard broadcastTimer == nil else { return }
        broadcastTimer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: false) { [weak self] _ in
            self?.broadcastTimer = nil
            self?.broadcastNow()
        }
    }

    private func broadcastNow() {
        var newPerTab: [UUID: ClaudeStatusInfo] = [:]
        for (tabId, tab) in tabs {
            newPerTab[tabId] = ClaudeStatusInfo(
                state: tab.state,
                description: tab.description,
                lastActivity: tab.lastActivity
            )
        }

        let aggregate = computeAggregate()

        DispatchQueue.main.async {
            self.perTabStatus = newPerTab
            self.aggregateStatus = aggregate

            // Write to shared UserDefaults for widget
            WidgetDataService.shared.writeStatus(aggregate)
        }
    }

    private func updateAggregate() {
        let aggregate = computeAggregate()
        DispatchQueue.main.async {
            self.aggregateStatus = aggregate
            WidgetDataService.shared.writeStatus(aggregate)
        }
    }

    /// Compute aggregate status — pick highest priority, break ties by recency.
    /// Direct port of getAggregateStatus() from main.js
    private func computeAggregate() -> ClaudeStatusInfo {
        var best = ClaudeStatusInfo.idle
        var bestActivity: Date = .distantPast

        for (_, tab) in tabs {
            let p = tab.state.priority
            let bestP = best.state.priority
            if p > bestP || (p == bestP && tab.lastActivity > bestActivity) {
                best = ClaudeStatusInfo(
                    state: tab.state,
                    description: tab.description,
                    lastActivity: tab.lastActivity
                )
                bestActivity = tab.lastActivity
            }
        }

        return best
    }
}
