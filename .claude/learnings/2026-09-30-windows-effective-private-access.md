---
date: 2026-09-30
problem: Windows migration readiness rejected newly replaced private files and skipped owned tasks whose original XML was gone.
tags: [security, windows, migration]
---

# Verify effective access and registered ownership

## Problem

Private settings and choices files are recreated after storage protection. On Windows they inherit the protected parent's owner-only ACE. The verifier rejected inheritance itself, so securely replaced files failed readiness. Task retirement also depended on the original XML file even though Task Scheduler retained the registered definition.

## Dead ends

- Requiring every file ACE to be explicit rejected effective owner-only access after atomic replacement.
- Looking for the original task XML could not retire a registered owned task after that input file was removed.
- Decoding `schtasks /Query /XML` as UTF-8 lost Japanese path characters under console codepage 932. Re-encoding the corrupted text as UTF-16 could not recover a usable rollback definition.

## Working approach

1. Keep directory DACLs protected with explicit inheritable owner-only FullControl.
2. Accept a file's sole effective owner Allow/FullControl ACE, including inheritance; reject foreign, multiple, denied, or inherit-only ACEs.
3. Export Task Scheduler's Unicode XML through PowerShell `Export-ScheduledTask` and explicitly set UTF-8 console output to match the Node decoder. Verify the managed marker and preserve a private encoding-correct backup before ending and deleting the task.
4. Test file recreation, atomic replacement, foreign ACL rejection, missing input XML, non-ASCII backup contents through the process-output decoding seam, and foreign task preservation.

## Why it worked

Security depends on effective access; task ownership depends on the registered definition. Neither depends on how a file or task was originally created. Contract tests prove these predicates on Linux; native Windows execution remains unverified.

## Reusable rule

When validating Windows private files after replacement, inspect the sole effective owner ACE rather than rejecting inheritance. When retiring a task, export its registered Unicode XML with an explicitly matched output encoding and back it up rather than relying on its former input file or the native CLI's console codepage.

## Pointers

- `scripts/private_storage.mjs` and `scripts/private_storage.test.mjs`
- `scripts/task_retirement.mjs` and `scripts/task_retirement.test.mjs`
- [Export-ScheduledTask](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/export-scheduledtask)
- [Console.OutputEncoding](https://learn.microsoft.com/en-us/dotnet/api/system.console.outputencoding)
