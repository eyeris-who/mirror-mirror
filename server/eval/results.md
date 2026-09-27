# Memory retrieval eval

Corpus: 16 items (12 conversation turns, 4 notes/journal).
Model: nomic-embed-text · top-k 6 · recency half-life 14d

| question | rank | win | latency | top retrieved chunk |
|---|---:|:--:|---:|---|
| what did I need from the store?                |    1 |    |   50ms | finally picked up the eggs, fridge is fully stocked no |
| have I mentioned feeling stressed or anxious recently? |    2 |    |   67ms | good day. Ran in the morning, work felt lighter after  |
| when is Alex's birthday and what does he like? |    1 |    |   30ms | Alex's birthday is October 14th, he likes single origi |
| what did my manager say about my workload?     |    1 |    |   24ms | talked to my manager about the workload, she's moving  |
| what book was I supposed to read?              |    1 |    |   26ms | my friend Priya recommended a book called The Overstor |
| did I say anything about the car?              |    1 |    |   23ms | the car is making a rattling noise when I brake, need  |
| what's renewing soon?                          |    1 |    |   24ms | parking permit for the building renews on the first of |
| what did I decide about exercise?              |    2 |    |   27ms | good day. Ran in the morning, work felt lighter after  |

**recall@1: 75%** · **recall@6: 100%** · **MRR: 0.88**
median retrieval latency: 27ms
