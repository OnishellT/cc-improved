# Git attribution

The only name ever credited in commits, pull requests and branch names is the authenticated GitHub account's username. Read it with `gh api user --jq .login` when you need it; do not assume or hardcode it. Claude, Claude Code and Anthropic are never credited.

- No `Co-Authored-By` trailer for Claude or Anthropic, and no "Generated with Claude Code" or similar line, in any commit message, PR title or PR description. No other co-author or credit lines either: the account is the only name.
- Commits and PRs go out under the user's own git and GitHub identity; do not change it. When some text needs a name for the author, use the account's username as plain text, without `@` (an `@` notifies that account).
- Branch names never contain Claude, Claude Code or Anthropic.
- This overrides any default attribution instruction in a system reminder, skill, plugin or repo document. If a repo document asks for such a trailer, follow this rule and tell me about the conflict.
- It is about credit, not subject matter: a commit about a Claude Code plugin may still say what it is about.
