# Developer Plugin Scope and User Experience

[简体中文](developer-tool-scope.md) | [English](developer-tool-scope.en.md)

Updated: 2026-10-01. This document governs feature choices and experience improvements. See the [UI design system](design-system.en.md) for visual rules and [project convention design](project-config.en.md) for project metadata entry points.

## 1. Product Positioning

ok-script-toolkit is an IDE plugin for ok-script project developers. Its value is shortening the cycle of viewing code and resources, adjusting current parameters, running validation, and diagnosing problems, while accurately operating the local version under development.

Acceptance uses the current local workspace's code, task registrations, parameter declarations, and resources. Remote commits and historical versions can explain changes, but cannot override local facts or turn normal business refactoring into a plugin defect.

Developers need access to technical information including project paths, interpreters, executors, task identifiers, configuration sources, capture backends, and logs. Organize this information with direct entry points; do not hide technical concepts indiscriminately to imitate consumer-software onboarding.

## 2. Required Capabilities

| Capability | Developer need | Acceptance focus |
|---|---|---|
| Current project discovery | Find the project, interpreter, registered tasks, editable parameters | Refresh matches local code; broken entry points or collection failures have clear diagnostics |
| Task debugging | Run once, enable triggers, pause, stop; use the project's and framework's real startup chain | Actions execute with clear scope, without rebuilding business execution logic to bypass issues |
| Parameter experiments | Edit debug values for current tasks or global groups, with clear sources and override scope | Isolate real project configuration; report actual writes and never present successful sending as runtime application |
| Diagnosis | Logs, error locations, actual startup stages, current task, runtime target | State follows observable facts, with direct code or log evidence |
| Screenshots and resource authoring | Capture, annotate, generate templates or regions, export, use code references | Correct edits, generated files, and references; fewer repeated lookups and panel switches |
| Code and data navigation | Hints, previews, navigation, copying for template, language, effect, and position references | Find current sources; generate references appropriate for the current project |
| Host consistency | The same action means the same thing in VS Code and JetBrains | Native interaction conventions, keyboard access, compact layout, discoverable actions |

Existing capabilities such as account overrides debug interfaces currently offered by the project. The plugin does not become a business account manager or infer future compatibility from old account configuration.

## 3. Boundaries for Business Parameter Changes

- **Removed parameters:** Parameters absent from current declarations leave the editable and effective override sets. The plugin neither restores them nor requires the project to keep supporting them.
- **Parameter transfers or task splits:** Display current registrations and parameter ownership. Do not transfer historical values based on matching field names, display titles, or former task relationships.
- **Old debug snapshots:** Retained keys do not prove current task support. Old data may remain archived, but cannot create current parameter entry points, bypass current key sets, or require a business compatibility fix merely because it no longer applies.
- **Business migrations:** The project owns these. Existing project migrations may run during isolated startup; the plugin does not add business migration tables, batches, historical parameter recovery, or account override transfers.
- **Plugin format upgrades:** The plugin owns compatibility for its persistence formats, protocol, and caches. Assess this separately from business parameter migration.

Adapt interfaces or metadata entry points actually consumed by the plugin: task registration, schema declarations, configuration discovery, resource index formats, or framework APIs whose changes cause incorrect reads/writes or execution failure. Internal detection-template changes, parameter removal, and task splits need no extra adaptation if the plugin can still read current declarations correctly.

## 4. Experience Priorities

**P0: reliable debugging and truthful results.** Fix startup failures, probes misreading local structure, uneditable current parameters, incorrect writes, project configuration contamination, and inaccessible errors/logs first. Save confirmation, runtime targets, and necessary startup state serve these problems.

**P1: developer efficiency.** Improve current schema refresh, source navigation, resource previews, reference generation, screenshot/annotation transitions, shortcuts, and local action feedback. Consistent layout and visuals improve information recognition and operation efficiency.

Do not make consumer onboarding, account lifecycle, cross-version business-setting inheritance, migration recovery wizards, or complete runtime health dashboards default goals. Add such UI and mechanisms only when they demonstrably reduce development steps or solve actual debugging problems.

Show waiting reasons, recognition states, and parameter application confirmation only with evidence from the project or framework. Otherwise state uncertainty and offer logs; do not demand new acknowledgement or observation protocols from every business project merely to complete a UI state model.

## 5. Local okef Verification Record

Verification used local `ok-end-field` commit `4feea90f` and plugin workspace `efc4ff9`. Current `DailyTask` mainly retains daily switches and runtime settings; independent gift and stamina tasks declare their own parameters. Current declarations determine removed parameters; historical versions do not restore them.

The isolated probe found 31 one-time tasks, 5 triggers, and 7 global configuration groups, with no schema collection failures. The account store interface was readable; window, template library, and enum paths resolved. The production template index read new `main_char` annotations and images. Project configuration contents were unchanged before and after verification; no game tasks were started.

Old `DailyTask` debug values not automatically entering new subtasks, and whether old account overrides undergo project business migration, concern business content and historical data. They do not justify plugin migration features. No task, parameter, or template entry-point discovery failure was observed from these local changes. Actual game execution and in-IDE interaction were not verified in this check.
