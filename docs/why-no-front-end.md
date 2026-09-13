# Why there is no front end

Harvest is a database with a subscription. The tables underneath it are ordinary: a few entities, a few relationships, a handful of workflows you repeat every week. What you pay for is the layer on top that lets people who do not write SQL get at those tables. Screens, filters, dashboards, forms.

That layer used to be the whole product, because talking to a database was hard. It is not hard any more. Open this folder in Claude Code, describe what you want, and it writes the query, runs it, and explains the answer. Ask a question the dashboard never had a chart for and you still get an answer.

## What you gain

- **Better answers.** A dashboard shows what the vendor decided to chart. Here you ask your own question, in your own words, and get it answered against your own data.
- **No seats.** Everyone who needs to look can look. The bill does not grow with headcount.
- **Your data in your Postgres.** Plain tables. Back them up, query them from anything, leave any time. There is no export step because there is nothing to leave.
- **A process that matches you.** When your way of working changes, you add a command. You do not wait for a feature request to clear.

## What you give up

- **The stopwatch.** There is no timer running in a browser tab. Time is logged after the fact, in one sentence: `/log Kauri intake 2h15 "conflict check screens"`. People who live by the timer will feel this on day one.
- **A phone app.** It runs where Claude Code runs. Time logged from the car goes into a note and gets entered later.
- **Approvals and payment links.** No timesheet approval workflow, no card payment button on the invoice, no automatic reminders. You mark an invoice sent and paid, and the chaser is a draft you send yourself.
- **A vendor help desk.** This is open source. Enterprise DNA supports the installed version for businesses that want someone to call.

## Who this fits

Small firms that bill by the hour, already use Claude Code, and would rather ask a question than learn another interface. If your team needs a timer button and a phone app, keep Harvest. If what you actually need is to know what is unbilled, what is over budget and who is slow to pay, this is cheaper, faster and yours.

Installed and run for you: https://enterprisedna.co/omni/instead-of/harvest
