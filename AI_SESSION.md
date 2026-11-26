# AI session log

I used OpenAI Codex to review the homework brief, explore the sample data, discuss the architecture, and implement and test the demo. The questions below summarize the conversation and are paraphrased for readability. Some questions were drafted afterward to document implementation decisions.

## Requirements and sample data

1. Can you look at `webhook_orders.jsonl` and tell me what fields come in with each order? Are any of them optional?
2. How is `api_responses.jsonl` structured? Is each line one order or a whole API response?
3. What kinds of responses are in the polling file? Are there any errors that still have order data in them?
4. What statuses do the items go through? Can you show me one item that changes status across responses?
5. Does the same order number show up more than once? Can you walk me through order `4702` and explain what changes each time it comes back?
6. Do all four CSV files have the same columns? What does each one mean?
7. What values are actually in the `tomorrow` and `meal` columns? How would we turn those into a scheduled time?
8. Do the newer CSV files include orders from the earlier ones? How many new orders would each upload add?

## Architecture and setup

1. What are my database options for this project? If I go with MySQL or Postgres, can I set it up with `npm` or `pip`, or do I need to install the database separately?
2. If I use SQLite, do I need to install anything separately?
3. Does it make a difference if I use Python or JavaScript with SQLite? Would either one need an extra driver or package? I want to keep setup as simple as possible.
4. Can I trigger all three ingestion pipelines—polling, webhooks, and CSV—with one button for the demo?
5. How many unique orders should show up after running the demo? What's the breakdown by source?
6. Do orders have a unique ID? Is that ID shared across all three sources, or does each source have its own?
7. Can we make sure running the demo again does not import the same orders twice? If a source does not give us a reliable order ID, could we hash the order data to recognize repeats?
8. How much work would it be to set up a queue? Could I use SQLite to hold incoming events until the worker can process them?
9. If an inbox event fails, can we retry it with a longer wait each time and hold later events for that same order behind it? After five failures, can we stop retrying and show it in the failed inbox count?
10. If the polling API returns a 500 with some order data in it, can we leave the checkpoint where it is and retry the same batch? Can you test that and check where polling resumes after a restart?
11. How do I point the poller at a real API? Can I set the URL, bearer token, and polling interval through environment variables?
12. For the demo, can we finish importing all three sources before sending eligible orders to the robots? I want the fixture updates and cancellations applied first.
13. Can we log which robot each order was assigned to? If the connection drops before we get an acknowledgment, can we retry the same robot with the same dispatch ID?
14. Can you draw a diagram of how webhooks, polling, and CSV uploads all feed into the same inbox, and how an order gets from there to a robot?
15. Can you show how data moves between the SQLite tables? I'd like to see where the current order, its history, and the robot assignment are saved.
16. Can you draw what happens when a robot accepts an order but the reply gets lost? Show how the app retries the same robot without creating a second job.
17. Can you show me the table schema based on what we discussed?
18. Can we keep a history of which robot each order was assigned to, when it was dispatched, and whether the robot acknowledged it?

## Implementation and follow-up

1. OK, let's build it. I want to be able to start the app and run the demo from the dashboard.
2. Can we validate webhook payloads and reject requests over 2 MB?
3. Can we add a button to clear the database so I can start the demo over? Have it ask me to type `clear` first.
4. Can I upload a CSV from the dashboard and choose its export date? Can we pass that date to the import endpoint so the app knows what `tomorrow` means for that file?
5. When I click an order, can I see all its items and a timeline of what happened to it?
6. When I filter the orders, can you show how many match right next to the Orders heading? I'd also like a little info icon next to each filter that explains the options.
7. Can I choose how many orders I see on each page and jump straight to the first or last page? Can you add tests for that too?
8. Can we show the extra counts by default and put the hide button below the cards? Anything that needs review should be red.
9. What should the dashboard show when an order has no items, when the polling provider has already handled fulfillment, or when a robot still hasn't acknowledged a dispatch after five attempts?
10. Dispatch pending goes by so fast I can barely see it. Can we randomly slow down some robot replies? Let's add a couple more robots too.
11. Can you put the dataflow diagram in the README and explain that I need to clear the database to run the demo from scratch?
12. Can you add a `curl` example to the README so I can send one webhook by hand? I'd also like instructions for trying each input separately and a section that explains the configuration and demo limitations.
