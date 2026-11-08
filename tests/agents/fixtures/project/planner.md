---
description: Project planner.
mode: primary
temperature: 0.2
permission:
  bash:
    '*': ask
    'git log*': allow
    'echo a:b*': deny
  edit: allow
  write: deny
  webfetch:
    'docs.*': ask
---
Project planner body with **markdown**.
