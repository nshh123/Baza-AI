# Git Push Workflow Rule

## Requirement
Upon completing any task, bug fix, feature addition, or refactoring in this repository:

1. **Verify**: Ensure the codebase passes build and type checks (`npx tsc --noEmit`).
2. **Stage**: Stage all modified and relevant new files (`git add .`).
3. **Commit**: Write a concise, descriptive commit message summarizing the changes (e.g. `feat: ...`, `fix: ...`, `perf: ...`).
4. **Push**: Push the committed changes to GitHub (`git push origin main`).
