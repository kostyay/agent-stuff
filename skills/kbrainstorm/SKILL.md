---
name: kbrainstorm
description: "You MUST use this before any creative work - creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements and design before implementation."
---

# Brainstorming Ideas Into Designs

## Overview

Help turn ideas into fully formed designs and specs through natural collaborative dialogue.

Start by understanding the current project context, then ask questions to refine the idea. Once you understand what you're building, present the design in small sections (200-300 words), checking after each section whether it looks right so far.

## How to Ask Questions

Use the `ask_question` tool for **every** question during brainstorming. It shows an interactive TUI where the user can select options or type freeform answers.

**One question per call.** Each answer informs the next question. Never batch multiple questions — the whole point is steering the conversation based on each response.

### Multiple choice

Provide `options` when there are clear alternatives. Always include a descriptive label; add `description` for extra context.

```
ask_question({
  question: "What is the primary purpose of this feature?",
  options: [
    { label: "User onboarding", description: "New user registration and setup flow" },
    { label: "Data export", description: "Export data in various formats" },
    { label: "Admin dashboard", description: "Internal monitoring and management" }
  ]
})
```

The user can pick an option or type a custom answer.

### Open-ended

Omit `options` for questions needing freeform answers.

```
ask_question({
  question: "What existing patterns in the codebase should we follow?",
  context: "I'll look at those files for reference"
})
```

### With context

Use the `context` field to show background information, constraints, or reasoning below the question.

```
ask_question({
  question: "Which approach should we go with?",
  context: "Approach A is simpler but limited to 1000 items. Approach B handles scale but requires a migration.",
  options: [
    { label: "Approach A: Simple adapter", description: "Wraps existing code, minimal changes" },
    { label: "Approach B: Native rewrite", description: "Better perf, requires migration" }
  ]
})
```

## Presenting Designs

When presenting analysis, comparisons, or design sections:

1. **Print to chat** — Write the content as regular markdown output (tables, diagrams, code blocks all work).
2. **Then ask for confirmation** — Use `ask_question` to check if the section looks right.

```
# (agent prints design section as markdown to chat)

ask_question({
  question: "Does this section look right?",
  options: [
    { label: "Looks good, continue" },
    { label: "Needs changes", description: "I'll explain what to adjust" }
  ]
})
```

For approach comparisons, print a markdown table comparing trade-offs, then ask which approach to take.

## The Process

**Understanding the idea:**
- Check out the current project state first (files, docs, recent commits)
- Ask questions one at a time using `ask_question`
- Focus on understanding: purpose, constraints, success criteria

**Exploring approaches:**
- Propose 2-3 different approaches with trade-offs
- Print a comparison table to chat, then use `ask_question` to pick
- Include your recommendation and reasoning in the `context` field

**Presenting the design:**
- Once you believe you understand what you're building, present the design
- Break it into sections of 200-300 words
- Print each section as markdown, then confirm with `ask_question`
- Cover: architecture, components, data flow, error handling, testing
- Be ready to go back and clarify if something doesn't make sense

## After the Design

**Documentation:**
- Write the validated design to `docs/plans/YYYY-MM-DD-<topic>-design.md`
- Commit the design document to git

**Implementation (if continuing):**
- Ask: "Ready to set up for implementation?" using `ask_question`

## Key Principles

- **Always use `ask_question`** — Never ask questions in plain text; always use the tool
- **One question per call** — Each answer must inform the next question
- **Never batch** — Do not ask multiple questions at once
- **Use context wisely** — Put background info, constraints, and your reasoning in the `context` field
- **YAGNI ruthlessly** — Remove unnecessary features from all designs
- **Explore alternatives** — Always propose 2-3 approaches before settling
- **Incremental validation** — Present design in sections, validate each
- **Be flexible** — Go back and clarify when something doesn't make sense
