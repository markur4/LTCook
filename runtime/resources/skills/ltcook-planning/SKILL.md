---
name: ltcook-planning
description: Use LTCook’s registered Design and Plan operations, decisions and execution approval gates.
---

# LTCook planning

Write Designs and Plans through native file tools under the runtime state directory’s `documents/designs/` and `documents/plans/`. Keep registered document references and filenames stable. Apply relevant User and Project planning guidance for personal methods and formats.

The actual user starts explicit planning with `ltcook planning start --session SESSION --design ABSOLUTE_DESIGN_PATH --title TITLE`. Use the returned Plan ID for `ltcook planning show` and `ltcook planning questions`, always with the explicit Session and Plan context. Agents use only the planning operations permitted by their bound `ltcook_team` tool; never invoke authenticated user-only start, answer, approve or reject operations on the user’s behalf. Adjutant prefills the Plan; Leader investigates and finalizes it through the registered workflow.

Cover intent, design, scope, implementation, verification and delivery. Resolve outstanding decisions, including the runtime’s mandatory question categories. Only actual user answers through native dialogs or authenticated `ltcook planning answer` operations resolve user questions. Only actual user `ltcook planning approve` authorizes execution; rejection, cancellation, defaults and agent reports grant no approval.

Before approval, keep project investigation read-only and write planning documents only in their designated directories. After approval, Leader registers execution Tasks and completes the scheduling handoff. Follow the selected Team’s assignment, reporting and review contract; no skill text overrides native tool authorization or member restrictions.
