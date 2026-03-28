import SwiftUI

/// Theme definitions — direct port from the desktop app's THEMES object in renderer.js.
///
/// Desktop themes: dark, light, purple, green
/// Each has: bg, bgSolid, border, accent, accentDim, text, textDim, textMuted, green,
///           termBg, termFg, termCursor
enum WotchTheme: String, Codable, CaseIterable, Identifiable {
    case dark
    case light
    case purple
    case green

    var id: String { rawValue }

    var displayName: String {
        rawValue.capitalized
    }

    // ── Colors ported from desktop THEMES ──

    var background: Color {
        switch self {
        case .dark:   return Color(hex: "0a0a12")
        case .light:  return Color(hex: "ffffff")
        case .purple: return Color(hex: "140a1e")
        case .green:  return Color(hex: "050f0a")
        }
    }

    var border: Color {
        switch self {
        case .dark:   return Color(hex: "94a3b8").opacity(0.12)
        case .light:  return Color(hex: "64748b").opacity(0.2)
        case .purple: return Color(hex: "a78bfa").opacity(0.15)
        case .green:  return Color(hex: "34d399").opacity(0.15)
        }
    }

    var accent: Color {
        switch self {
        case .dark:   return Color(hex: "a78bfa")
        case .light:  return Color(hex: "7c3aed")
        case .purple: return Color(hex: "c084fc")
        case .green:  return Color(hex: "34d399")
        }
    }

    var accentDim: Color {
        switch self {
        case .dark:   return Color(hex: "a78bfa").opacity(0.15)
        case .light:  return Color(hex: "7c3aed").opacity(0.1)
        case .purple: return Color(hex: "c084fc").opacity(0.15)
        case .green:  return Color(hex: "34d399").opacity(0.15)
        }
    }

    var text: Color {
        switch self {
        case .dark:   return Color(hex: "e2e8f0")
        case .light:  return Color(hex: "1e293b")
        case .purple: return Color(hex: "e2e8f0")
        case .green:  return Color(hex: "d1fae5")
        }
    }

    var textDim: Color {
        switch self {
        case .dark:   return Color(hex: "64748b")
        case .light:  return Color(hex: "64748b")
        case .purple: return Color(hex: "a78bfa")
        case .green:  return Color(hex: "6ee7b7")
        }
    }

    var textMuted: Color {
        switch self {
        case .dark:   return Color(hex: "475569")
        case .light:  return Color(hex: "94a3b8")
        case .purple: return Color(hex: "6d28d9")
        case .green:  return Color(hex: "065f46")
        }
    }

    var statusGreen: Color {
        Color(hex: "34d399")
    }

    // Terminal-specific colors
    var terminalBackground: Color { background }
    var terminalForeground: Color { text }
    var terminalCursor: Color { accent }
}

// MARK: - Color hex initializer

extension Color {
    init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let a, r, g, b: UInt64
        switch hex.count {
        case 3: // RGB (12-bit)
            (a, r, g, b) = (255, (int >> 8) * 17, (int >> 4 & 0xF) * 17, (int & 0xF) * 17)
        case 6: // RGB (24-bit)
            (a, r, g, b) = (255, int >> 16, int >> 8 & 0xFF, int & 0xFF)
        case 8: // ARGB (32-bit)
            (a, r, g, b) = (int >> 24, int >> 16 & 0xFF, int >> 8 & 0xFF, int & 0xFF)
        default:
            (a, r, g, b) = (255, 0, 0, 0)
        }
        self.init(
            .sRGB,
            red: Double(r) / 255,
            green: Double(g) / 255,
            blue: Double(b) / 255,
            opacity: Double(a) / 255
        )
    }
}
