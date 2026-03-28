import SwiftUI

/// Main connections list — shows saved SSH profiles and their status.
/// Equivalent to the desktop's tab bar + SSH profile quick-access menu.
struct ConnectionListView: View {
    @EnvironmentObject var appState: AppState
    @StateObject private var viewModel = ConnectionListViewModel()

    var body: some View {
        NavigationStack {
            List {
                if appState.sshProfiles.isEmpty {
                    emptyState
                } else {
                    profilesSection
                }
            }
            .navigationTitle("Wotch")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        viewModel.addProfile()
                    } label: {
                        Image(systemName: "plus")
                    }
                }
            }
            .sheet(isPresented: $viewModel.showAddProfile) {
                ProfileEditorView(
                    profile: viewModel.editingProfile,
                    onSave: { profile in
                        appState.saveProfile(profile)
                        viewModel.showAddProfile = false
                    }
                )
            }
            .onAppear {
                viewModel.load(from: appState)
            }
        }
    }

    // MARK: - Sections

    private var emptyState: some View {
        Section {
            VStack(spacing: 16) {
                Image(systemName: "network.slash")
                    .font(.system(size: 48))
                    .foregroundStyle(appState.selectedTheme.textMuted)

                Text("No Connections")
                    .font(.headline)

                Text("Add an SSH profile to connect to your VPS and monitor Claude Code activity.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)

                Button("Add Connection") {
                    viewModel.addProfile()
                }
                .buttonStyle(.borderedProminent)
                .tint(appState.selectedTheme.accent)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 32)
        }
    }

    private var profilesSection: some View {
        Section("SSH Profiles") {
            ForEach(appState.sshProfiles) { profile in
                NavigationLink {
                    TerminalView(profile: profile)
                } label: {
                    ProfileRow(
                        profile: profile,
                        isConnected: viewModel.activeConnectionIds.contains(profile.id)
                    )
                }
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) {
                        viewModel.deleteProfile(profile, appState: appState)
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }

                    Button {
                        viewModel.editProfile(profile)
                    } label: {
                        Label("Edit", systemImage: "pencil")
                    }
                    .tint(.orange)
                }
            }
        }
    }
}

// MARK: - Profile Row

struct ProfileRow: View {
    let profile: SSHProfile
    let isConnected: Bool

    var body: some View {
        HStack(spacing: 12) {
            // Status dot — mirrors the desktop pill's status dot
            Circle()
                .fill(isConnected ? Color(hex: "34d399") : Color(hex: "64748b"))
                .frame(width: 10, height: 10)
                .shadow(color: isConnected ? Color(hex: "34d399").opacity(0.5) : .clear, radius: 4)

            VStack(alignment: .leading, spacing: 2) {
                Text(profile.displayName)
                    .font(.body.weight(.medium))

                HStack(spacing: 4) {
                    Image(systemName: profile.authMethod == .key ? "key.fill" : "lock.fill")
                        .font(.caption2)
                    Text("\(profile.username)@\(profile.host):\(profile.validatedPort)")
                        .font(.caption)
                }
                .foregroundStyle(.secondary)
            }

            Spacer()

            if isConnected {
                Text("Connected")
                    .font(.caption)
                    .foregroundStyle(Color(hex: "34d399"))
            }
        }
        .padding(.vertical, 4)
    }
}
