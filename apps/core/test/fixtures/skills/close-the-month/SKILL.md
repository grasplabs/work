---
name: close-the-month
description: Closes the month for the accounts, once every invoice is matched and booked. Use at the end of a month.
tasks: [month.close]
prerequisites:
  - { collection: grasp-skills, name: file-an-expense }
status: accepted
---

# Close the month

Closing the month freezes the accounts of a month, so its figures can be reported.

## Steps

1. **Check every expense is filed**: see the `file-an-expense` skill.
2. **Match every invoice** to its payment.
3. **Close it**, with the date it was closed.
