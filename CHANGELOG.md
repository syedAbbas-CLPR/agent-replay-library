# Changelog

## 0.2.1

- Animate trace blocks closed over 0.3 seconds when side-arrow navigation leaves them
- Flash skipped command blocks for 0.4 seconds without opening them
- Use a yellow Current marker so navigation focus is distinct from white block borders
- Ignore one-word follow-ups when a more descriptive recent message can name the terminal
- Keep the highlighted trace block centered while earlier blocks collapse and shift the page

## 0.2.0

- Group Claude JSONL segments connected by `/clear` into one terminal timeline
- Label terminals from the latest descriptive user message and show the working folder
- Resume Claude and Codex terminals from the session rail
- Exclude Codex worker sessions from the top-level terminal list
- Preserve old selected-session IDs and notes while migrating to terminal groups
- Export every clear segment with terminal metadata

## 0.1.1

- Keep arrow navigation synchronized with prompt-peak clicks and manual scrolling
- Enter the active turn at its first major block after selecting a prompt peak
- Clear stale trace focus when the reader moves elsewhere

## 0.1.0

- First public release
