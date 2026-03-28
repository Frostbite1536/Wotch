import SwiftUI

/// Root view — tab-based navigation with Connections and Settings tabs.
struct ContentView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        TabView {
            ConnectionListView()
                .tabItem {
                    Label("Connections", systemImage: "network")
                }

            SettingsView()
                .tabItem {
                    Label("Settings", systemImage: "gear")
                }
        }
        .tint(appState.selectedTheme.accent)
    }
}
