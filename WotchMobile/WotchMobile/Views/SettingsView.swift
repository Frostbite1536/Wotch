import SwiftUI

/// Settings view — mirrors the desktop's settings panel.
/// Covers: theme selection, known hosts management, about info.
struct SettingsView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        NavigationStack {
            Form {
                appearanceSection
                securitySection
                aboutSection
            }
            .navigationTitle("Settings")
        }
    }

    // MARK: - Appearance

    private var appearanceSection: some View {
        Section("Appearance") {
            ForEach(WotchTheme.allCases) { theme in
                Button {
                    appState.setTheme(theme)
                } label: {
                    HStack {
                        // Color swatch preview
                        HStack(spacing: 2) {
                            Circle().fill(theme.background).frame(width: 16, height: 16)
                            Circle().fill(theme.accent).frame(width: 16, height: 16)
                            Circle().fill(theme.text).frame(width: 16, height: 16)
                        }

                        Text(theme.displayName)
                            .foregroundStyle(.primary)

                        Spacer()

                        if appState.selectedTheme == theme {
                            Image(systemName: "checkmark")
                                .foregroundStyle(theme.accent)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Security

    private var securitySection: some View {
        Section("Security") {
            NavigationLink {
                KnownHostsView()
            } label: {
                HStack {
                    Label("Known Hosts", systemImage: "shield.checkered")
                    Spacer()
                    Text("\(KnownHostsService.shared.loadAll().count)")
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    // MARK: - About

    private var aboutSection: some View {
        Section("About") {
            HStack {
                Text("Wotch Mobile")
                Spacer()
                Text("0.1.0")
                    .foregroundStyle(.secondary)
            }

            HStack {
                Text("Based on")
                Spacer()
                Text("Wotch Desktop")
                    .foregroundStyle(.secondary)
            }

            Text("A companion app for monitoring Claude Code sessions on your VPS via SSH.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - Known Hosts View

struct KnownHostsView: View {
    @State private var knownHosts: [String: String] = [:]

    var body: some View {
        List {
            if knownHosts.isEmpty {
                Text("No known hosts yet. Connect to a server to add one.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(knownHosts.keys.sorted()), id: \.self) { hostKey in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(hostKey)
                            .font(.body.monospaced())
                        Text("SHA256:\(knownHosts[hostKey] ?? "")")
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    .swipeActions {
                        Button(role: .destructive) {
                            let parts = hostKey.split(separator: ":")
                            if parts.count == 2, let port = Int(parts[1]) {
                                KnownHostsService.shared.remove(host: String(parts[0]), port: port)
                                knownHosts = KnownHostsService.shared.loadAll()
                            }
                        } label: {
                            Label("Remove", systemImage: "trash")
                        }
                    }
                }
            }
        }
        .navigationTitle("Known Hosts")
        .toolbar {
            if !knownHosts.isEmpty {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Clear All", role: .destructive) {
                        KnownHostsService.shared.clearAll()
                        knownHosts = [:]
                    }
                }
            }
        }
        .onAppear {
            knownHosts = KnownHostsService.shared.loadAll()
        }
    }
}
