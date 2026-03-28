import Foundation
import SwiftUI

/// Claude Code activity states — direct port from the desktop app's 6-state machine.
///
/// Desktop states: idle, thinking, working, waiting, done, error
/// Priority order (highest first): error(6) > working(5) > thinking(4) > waiting(2) > done(1) > idle(0)
enum ClaudeState: String, Codable, CaseIterable {
    case idle
    case thinking
    case working
    case waiting
    case done
    case error

    /// Priority for aggregate status (pick the "most interesting" across tabs)
    var priority: Int {
        switch self {
        case .error: return 6
        case .working: return 5
        case .thinking: return 4
        case .waiting: return 2
        case .done: return 1
        case .idle: return 0
        }
    }

    /// Status dot color — matches the desktop app's CSS exactly:
    ///   idle/done: green (#34d399)
    ///   thinking: accent purple (#a78bfa)
    ///   working: blue (#60a5fa)
    ///   waiting: yellow (#fbbf24)
    ///   error: red (#f87171)
    var color: Color {
        switch self {
        case .idle, .done: return Color(hex: "34d399")
        case .thinking: return Color(hex: "a78bfa")
        case .working: return Color(hex: "60a5fa")
        case .waiting: return Color(hex: "fbbf24")
        case .error: return Color(hex: "f87171")
        }
    }

    /// Whether the status dot should pulse (matches desktop CSS animations)
    var shouldPulse: Bool {
        switch self {
        case .thinking, .working, .waiting: return true
        default: return false
        }
    }

    /// Human-readable label for the widget
    var label: String {
        switch self {
        case .idle: return "Ready"
        case .thinking: return "Thinking"
        case .working: return "Working"
        case .waiting: return "Waiting for input"
        case .done: return "Done"
        case .error: return "Error"
        }
    }

    /// SF Symbol name for widget display
    var sfSymbol: String {
        switch self {
        case .idle: return "checkmark.circle.fill"
        case .thinking: return "brain.head.profile"
        case .working: return "hammer.fill"
        case .waiting: return "questionmark.circle.fill"
        case .done: return "checkmark.seal.fill"
        case .error: return "exclamationmark.triangle.fill"
        }
    }
}

/// Status snapshot for a single connection/tab
struct ClaudeStatusInfo: Codable, Equatable {
    var state: ClaudeState
    var description: String
    var lastActivity: Date

    static let idle = ClaudeStatusInfo(state: .idle, description: "", lastActivity: .now)
}
