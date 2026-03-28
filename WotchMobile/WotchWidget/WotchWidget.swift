import WidgetKit
import SwiftUI

// MARK: - Timeline Provider

struct WotchStatusProvider: TimelineProvider {
    private let dataService = WidgetDataService.shared

    func placeholder(in context: Context) -> WotchStatusEntry {
        WotchStatusEntry(
            date: .now,
            status: ClaudeStatusInfo(state: .idle, description: "Ready", lastActivity: .now),
            connectionName: "VPS",
            isConnected: true
        )
    }

    func getSnapshot(in context: Context, completion: @escaping (WotchStatusEntry) -> Void) {
        let entry = WotchStatusEntry(
            date: .now,
            status: dataService.readStatus(),
            connectionName: dataService.readConnectionName() ?? "Not connected",
            isConnected: dataService.readIsConnected()
        )
        completion(entry)
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<WotchStatusEntry>) -> Void) {
        let entry = WotchStatusEntry(
            date: .now,
            status: dataService.readStatus(),
            connectionName: dataService.readConnectionName() ?? "Not connected",
            isConnected: dataService.readIsConnected()
        )

        // Refresh every 5 minutes (the main app also pushes updates via WidgetCenter)
        let nextUpdate = Calendar.current.date(byAdding: .minute, value: 5, to: .now)!
        let timeline = Timeline(entries: [entry], policy: .after(nextUpdate))
        completion(timeline)
    }
}

// MARK: - Timeline Entry

struct WotchStatusEntry: TimelineEntry {
    let date: Date
    let status: ClaudeStatusInfo
    let connectionName: String
    let isConnected: Bool
}

// MARK: - Widget Views

/// Small widget — status dot + state label
struct WotchWidgetSmallView: View {
    let entry: WotchStatusEntry

    var body: some View {
        VStack(spacing: 8) {
            // Wotch branding
            HStack(spacing: 4) {
                Image(systemName: "terminal.fill")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text("WOTCH")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.secondary)
            }

            // Large status dot
            Circle()
                .fill(entry.status.state.color)
                .frame(width: 32, height: 32)
                .shadow(color: entry.status.state.color.opacity(0.4), radius: 8)

            // State label
            Text(entry.status.state.label)
                .font(.system(size: 13, weight: .medium, design: .monospaced))

            // Description or connection info
            if !entry.status.description.isEmpty {
                Text(entry.status.description)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            } else if entry.isConnected {
                Text(entry.connectionName)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .containerBackground(for: .widget) {
            Color(hex: "0a0a12")
        }
    }
}

/// Medium widget — dot + state + description + connection info
struct WotchWidgetMediumView: View {
    let entry: WotchStatusEntry

    var body: some View {
        HStack(spacing: 16) {
            // Left: large status indicator
            VStack(spacing: 8) {
                ZStack {
                    Circle()
                        .fill(entry.status.state.color.opacity(0.15))
                        .frame(width: 56, height: 56)
                    Circle()
                        .fill(entry.status.state.color)
                        .frame(width: 28, height: 28)
                        .shadow(color: entry.status.state.color.opacity(0.5), radius: 8)
                }

                Image(systemName: entry.status.state.sfSymbol)
                    .font(.caption)
                    .foregroundStyle(entry.status.state.color)
            }

            // Right: text info
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 4) {
                    Image(systemName: "terminal.fill")
                        .font(.caption2)
                    Text("WOTCH")
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                }
                .foregroundStyle(.secondary)

                Text(entry.status.state.label)
                    .font(.system(size: 17, weight: .semibold, design: .monospaced))

                if !entry.status.description.isEmpty {
                    Text(entry.status.description)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                Spacer()

                HStack(spacing: 4) {
                    Circle()
                        .fill(entry.isConnected ? Color(hex: "34d399") : Color(hex: "64748b"))
                        .frame(width: 6, height: 6)
                    Text(entry.isConnected ? entry.connectionName : "Disconnected")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }
            }

            Spacer()
        }
        .padding(4)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .containerBackground(for: .widget) {
            Color(hex: "0a0a12")
        }
    }
}

/// Lock screen circular widget
struct WotchWidgetAccessoryCircularView: View {
    let entry: WotchStatusEntry

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 2) {
                Circle()
                    .fill(entry.status.state.color)
                    .frame(width: 12, height: 12)
                Text(entry.status.state.rawValue.prefix(4).uppercased())
                    .font(.system(size: 8, weight: .bold, design: .monospaced))
            }
        }
    }
}

/// Lock screen inline widget
struct WotchWidgetAccessoryInlineView: View {
    let entry: WotchStatusEntry

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: entry.status.state.sfSymbol)
            Text("Claude: \(entry.status.state.label)")
        }
    }
}

/// Lock screen rectangular widget
struct WotchWidgetAccessoryRectangularView: View {
    let entry: WotchStatusEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Image(systemName: "terminal.fill")
                    .font(.caption2)
                Text("Wotch")
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
            }

            HStack(spacing: 4) {
                Circle()
                    .fill(entry.status.state.color)
                    .frame(width: 8, height: 8)
                Text(entry.status.state.label)
                    .font(.system(size: 13, weight: .medium, design: .monospaced))
            }

            if !entry.status.description.isEmpty {
                Text(entry.status.description)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }
}

// MARK: - Widget Configuration

struct WotchStatusWidget: Widget {
    let kind: String = "WotchStatusWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: WotchStatusProvider()) { entry in
            if #available(iOS 17.0, *) {
                WotchWidgetEntryView(entry: entry)
            } else {
                WotchWidgetEntryView(entry: entry)
            }
        }
        .configurationDisplayName("Claude Status")
        .description("Monitor your Claude Code session status at a glance.")
        .supportedFamilies([
            .systemSmall,
            .systemMedium,
            .accessoryCircular,
            .accessoryInline,
            .accessoryRectangular,
        ])
    }
}

/// Entry view that adapts to widget family
struct WotchWidgetEntryView: View {
    @Environment(\.widgetFamily) var family
    let entry: WotchStatusEntry

    var body: some View {
        switch family {
        case .systemSmall:
            WotchWidgetSmallView(entry: entry)
        case .systemMedium:
            WotchWidgetMediumView(entry: entry)
        case .accessoryCircular:
            WotchWidgetAccessoryCircularView(entry: entry)
        case .accessoryInline:
            WotchWidgetAccessoryInlineView(entry: entry)
        case .accessoryRectangular:
            WotchWidgetAccessoryRectangularView(entry: entry)
        default:
            WotchWidgetSmallView(entry: entry)
        }
    }
}

// MARK: - Widget Bundle

@main
struct WotchWidgetBundle: WidgetBundle {
    var body: some Widget {
        WotchStatusWidget()
    }
}

// MARK: - Previews

#Preview("Small", as: .systemSmall) {
    WotchStatusWidget()
} timeline: {
    WotchStatusEntry(date: .now, status: .idle, connectionName: "my-vps", isConnected: true)
    WotchStatusEntry(date: .now, status: ClaudeStatusInfo(state: .thinking, description: "Thinking...", lastActivity: .now), connectionName: "my-vps", isConnected: true)
    WotchStatusEntry(date: .now, status: ClaudeStatusInfo(state: .working, description: "Editing main.swift", lastActivity: .now), connectionName: "my-vps", isConnected: true)
}

#Preview("Medium", as: .systemMedium) {
    WotchStatusWidget()
} timeline: {
    WotchStatusEntry(date: .now, status: ClaudeStatusInfo(state: .working, description: "Editing 3 files (AppDelegate.swift)", lastActivity: .now), connectionName: "production-vps", isConnected: true)
}

#Preview("Circular", as: .accessoryCircular) {
    WotchStatusWidget()
} timeline: {
    WotchStatusEntry(date: .now, status: ClaudeStatusInfo(state: .thinking, description: "", lastActivity: .now), connectionName: "vps", isConnected: true)
}

#Preview("Rectangular", as: .accessoryRectangular) {
    WotchStatusWidget()
} timeline: {
    WotchStatusEntry(date: .now, status: ClaudeStatusInfo(state: .working, description: "Building project...", lastActivity: .now), connectionName: "vps", isConnected: true)
}
