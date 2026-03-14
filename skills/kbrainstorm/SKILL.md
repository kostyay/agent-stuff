---
name: kbrainstorm
description: "You MUST use this before any creative work - creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements and design before implementation."
---

# Brainstorming Ideas Into Designs

## Overview

Help turn ideas into fully formed designs and specs through natural collaborative dialogue.

Start by understanding the current project context, then ask questions to refine the idea. Once you understand what you're building, present the design in small sections (200-300 words), checking after each section whether it looks right so far.

## How to Ask Questions

Use the `interview` tool for **every** question during brainstorming. It opens a native form window where the user can select options, type freeform answers, and see rich context including code blocks, tables, and diagrams.

### Sequential questions (default)

Ask one question per `interview` call when each answer influences the next. Process the response before asking the next question.

```
interview({
  questions: JSON.stringify({
    title: "Feature Purpose",
    description: "Help me understand scope and target audience",
    questions: [{
      id: "purpose",
      type: "single",
      question: "What is the primary purpose of this feature?",
      options: [
        { label: "User onboarding", description: "New user registration and setup flow" },
        { label: "Data export", description: "Export data in various formats" },
        { label: "Admin dashboard", description: "Internal monitoring and management" }
      ],
      recommended: { option: "User onboarding", context: "Based on the recent signup page changes" },
      conviction: "slight"
    }]
  })
})
```

### Batching independent questions

When 2-4 questions don't depend on each other's answers, batch them into a single `interview` call. This reduces round-trips without losing information.

```
interview({
  questions: JSON.stringify({
    title: "Initial Requirements",
    description: "Review my suggestions and adjust as needed",
    questions: [
      {
        id: "target_users",
        type: "single",
        question: "Who are the target users?",
        options: ["Internal team", "External customers", "Both"],
        weight: "critical"
      },
      {
        id: "constraints",
        type: "multi",
        question: "Which constraints apply?",
        options: ["Must work offline", "Mobile-first", "Backward compatible", "Real-time updates"]
      },
      {
        id: "timeline",
        type: "single",
        question: "What's the timeline?",
        options: ["Days", "Weeks", "No rush"],
        weight: "minor"
      }
    ]
  })
})
```

### Open-ended questions

Use `type: "text"` for questions needing freeform answers.

```
interview({
  questions: JSON.stringify({
    title: "Codebase Patterns",
    questions: [{
      id: "patterns",
      type: "text",
      question: "What existing patterns in the codebase should we follow?",
      description: "I'll look at those files for reference"
    }]
  })
})
```

### Presenting approaches with context

Use `info` type questions alongside choice questions to show analysis, code snippets, or diagrams before asking the user to pick.

```
interview({
  questions: JSON.stringify({
    title: "Architecture Decision",
    description: "I've analyzed the codebase and have two approaches",
    questions: [
      {
        id: "analysis",
        type: "info",
        question: "Trade-off Analysis",
        media: {
          type: "table",
          table: {
            headers: ["", "Approach A", "Approach B"],
            rows: [
              ["Complexity", "Low", "Medium"],
              ["Performance", "Good", "Better"],
              ["Migration effort", "None", "2-3 hours"]
            ]
          }
        }
      },
      {
        id: "approach",
        type: "single",
        question: "Which approach should we go with?",
        options: [
          { label: "Approach A: Simple adapter", description: "Wraps existing code, minimal changes" },
          { label: "Approach B: Native rewrite", description: "Better perf, requires migration" }
        ],
        recommended: { option: "Approach A: Simple adapter", context: "Lower risk, can upgrade later" },
        weight: "critical"
      }
    ]
  })
})
```

### Design section validation

When presenting a design section for validation, use `info` to show the design and a `single` question to confirm.

```
interview({
  questions: JSON.stringify({
    title: "Design Review: Data Layer",
    questions: [
      {
        id: "design_section",
        type: "info",
        question: "Proposed Data Layer Design",
        media: {
          type: "mermaid",
          mermaid: "graph LR\n  A[API] --> B[Cache]\n  B --> C[Store]"
        }
      },
      {
        id: "approval",
        type: "single",
        question: "Does this section look right?",
        options: [
          { label: "Looks good, continue" },
          { label: "Needs changes", description: "I'll explain what to adjust" }
        ]
      }
    ]
  })
})
```

## The Process

**Understanding the idea:**
- Check out the current project state first (files, docs, recent commits)
- Ask questions using the `interview` tool
- Batch independent questions (2-4 max) when answers don't depend on each other
- Keep sequential flow when answers influence the next question
- Focus on understanding: purpose, constraints, success criteria

**Exploring approaches:**
- Propose 2-3 different approaches with trade-offs
- Use `info` questions with tables or mermaid diagrams to present comparisons
- Set `recommended` with your pick and reasoning; use `conviction: "strong"` when confident
- Use `weight: "critical"` for the approach selection question

**Presenting the design:**
- Once you believe you understand what you're building, present the design
- Break it into sections of 200-300 words
- Use `info` + confirmation pattern to validate each section
- Include mermaid diagrams for architecture and data flow where helpful
- Cover: architecture, components, data flow, error handling, testing
- Be ready to go back and clarify if something doesn't make sense

## After the Design

**Documentation:**
- Write the validated design to `docs/plans/YYYY-MM-DD-<topic>-design.md`
- Use elements-of-style:writing-clearly-and-concisely skill if available
- Commit the design document to git

**Implementation (if continuing):**
- Ask: "Ready to set up for implementation?" (using `interview`)
- Use superpowers:using-git-worktrees to create isolated workspace if available
- Use superpowers:writing-plans to create detailed implementation plan if available

## Key Principles

- **Always use `interview`** — Never ask questions in plain text; always use the tool
- **Batch when independent** — Group 2-4 unrelated questions to reduce round-trips
- **Sequential when dependent** — One interview call per question when answers inform the next
- **Use recommendations** — Always set `recommended` when you have an opinion; use `conviction` to signal confidence
- **Rich context** — Use `info` panels with tables, mermaid diagrams, and code blocks to present analysis
- **Weight signals importance** — Mark key decisions `"critical"`, low-stakes questions `"minor"`
- **YAGNI ruthlessly** — Remove unnecessary features from all designs
- **Explore alternatives** — Always propose 2-3 approaches before settling
- **Incremental validation** — Present design in sections, validate each
- **Be flexible** — Go back and clarify when something doesn't make sense
