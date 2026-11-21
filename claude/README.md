# loupe for Claude Code

Claude Code's side of loupe, installed by `./install.sh` (or by hand: `claude plugin marketplace add <this repository>`,
then `claude plugin install loupe@loupe`). It has two parts.

**The mod** notes every git repository the session edits (Edit, Write, MultiEdit, NotebookEdit). The first edit in a
repository puts it on loupe's home by itself, with the session's name beside it. Then:

- `/loupe` prints a loupe link per repository, each showing the branch plus uncommitted work, and gives each
  workspace a chat linked to this session: a read-only fork that answers from what this session already knows.
  The session itself is untouched.
- `/loupe open` does the same and opens the links in the browser.
- `/loupe live` makes this session answer the browser: questions typed in loupe's "Live session" chat arrive here
  as prompts marked `[From loupe]`, and each answer goes back to the chat. It answers with this session's own
  tools and permissions. `/loupe off` stops it; ending the session stops it too.
- Once the session has edited something, a row above the prompt names the repositories, with Review (opens
  them) and Hide.

**The skill** tells Claude how to open a PR, branch or path in loupe, and what to check when loupe misbehaves.

Both need the loupe daemon running (`loupe service install`); without it the command says so and does nothing else.
Nothing opens unless you ask.
