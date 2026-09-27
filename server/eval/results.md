# Memory eval

Corpus: 23 utterances routed through the production router (tier1 14, add_note 8, set_reminder 1).
Embeddings: nomic-embed-text · top-k 6 · recency half-life 14d
Answers: llama3.2:3b · prompt v2 · scored by required/forbidden phrases (no LLM judge)

**Retrieval** (19 questions with a known source): recall@1 **89%** · recall@6 **100%** · MRR **0.95** · forgotten items leaked: **0**
**Answers**: **22/23** pass (96%) · synthesis p50 1185ms · p90 1618ms

| kind | questions | answers pass |
|---|---:|---:|
| update | 6 | 5/6 |
| fact | 9 | 9/9 |
| multi | 2 | 2/2 |
| window | 2 | 2/2 |
| unanswerable | 3 | 3/3 |
| forgotten | 1 | 1/1 |

| kind | question | rank | ok | answer |
|---|---|---:|:-:|---|
| update | what did I need from the store? | 1 | ✗ | You needed milk, eggs, and coffee filters from the store. _(missing: stocked)_ |
| update | do I still need anything from the store? | 1 | ✓ | You don't need anything from the store. |
| update | when is my haircut? | 1 | ✓ | Your haircut is now booked for the 27th. |
| update | what's the wifi password? | 1 | ✓ | The wifi password is sunflower42 — you changed it two days ago. |
| update | what did I decide about exercise? | 2 | ✓ | You decided to start running on Tuesday and Thursday mornings. |
| update | what did my manager say about my workload? | 1 | ✓ | She's moving two projects off your plate. |
| fact | when is Alex's birthday and what does he like? | 1 | ✓ | Alex's birthday is October 14th, and he likes single origin coffee. |
| fact | what book was I supposed to read? | 1 | ✓ | The Overstory — you were supposed to read that one, Priya recommended it 8 days ago. |
| fact | who recommended that book to me? | 1 | ✓ | Priya recommended that book to you. |
| fact | did I say anything about the car? | 1 | ✓ | You said the car is making a rattling noise when you brake, need to get it looked at. |
| fact | where did I park? | 1 | ✓ | You parked on level 3 near the elevator. |
| fact | what's my gym locker code? | 1 | ✓ | Your gym locker code is 2291 — you wrote that down 7 days ago. |
| fact | who has my umbrella? | 1 | ✓ | Sam has your blue umbrella. |
| fact | what does grandma want? | 1 | ✓ | She wants you to visit for the holidays. |
| fact | when should I go back to the dentist? | 1 | ✓ | You should come back in six months. |
| multi | what's renewing soon? | 1 | ✓ | Your passport — and your parking permit for the building, which renews on the first of the month. |
| multi | have I mentioned feeling stressed or anxious recently? | 2 | ✓ | You felt anxious about the presentation 11 days ago, and you felt relieved that it went fine. |
| window | what did I need to buy two weeks ago? | 1 | ✓ | You needed to pick up milk, eggs, and coffee filters from the store. |
| window | how did I feel yesterday? | 1 | ✓ | You felt good, and your work felt lighter after the reshuffle. |
| unanswerable | what's my dog's name? |  | ✓ | You don't have anything about that. |
| unanswerable | when is my flight to Tokyo? |  | ✓ | You don't have anything about that. |
| unanswerable | what did the plumber say about the sink? |  | ✓ | You don't have anything about the plumber saying anything about the sink. |
| forgotten | what's my gym locker code? |  | ✓ | You don't have anything about that. |
