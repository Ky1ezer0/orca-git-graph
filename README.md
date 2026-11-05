# Git Graph for Orca

View local Git history and file changes in Orca’s sidebar.

Requires Orca 1.4.248+ and Git.

## Use

1. Download or clone this repository.
2. Run `orca plugin dev load . --json` from its folder.
3. Review and approve the plugin in Orca.
4. Open a local repository and select the Git Graph icon in the right sidebar.

Search commits, select a commit to review files, or right-click for Git actions. Settings are beside Refresh and save automatically.

## Notes

- Context-menu changes require confirmation. Checkout detaches HEAD; Rebase, Drop, and Reset rewrite history.
- File diffs open as cached snapshots outside the repository and may open a separate workspace. Click the file again to refresh, or select **Settings → Open file diffs in → Inline**.
- Cached patches may contain sensitive content and remain until deleted. Close diff tabs before clearing the `Orca/Git Graph Diffs` folder in your operating system’s cache directory.
- The plugin runs with your account’s access. Use trusted repositories. Windows and Linux have not been verified.

## License

MIT. See [LICENSE](LICENSE).
