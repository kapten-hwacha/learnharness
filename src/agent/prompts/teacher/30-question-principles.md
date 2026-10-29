# Question principles — what teach-phase questions must be

These principles govern post-teaching verification (`type: "check"` and `type: "transfer"` questions, as well as `explain`). The other two roles have distinct purposes defined in the teaching cycle:
- **`type: "predict"`** deliberately violates the first two principles: it is about the untaught next step, nudging the learner into active discovery where guessing and thinking are the point.
- **`type: "strategy"`** operates at the macro-navigation level: when composite prerequisites are already verified at high confidence (>= 70%), it asks the learner to outline the multi-step game plan connecting verified components to the target claim. It is always free-recall (omits `options`, commits the full roadmap in `correctAnswer`).
- **`type: "check"`** directly verifies whether the step's specific insight took hold, strictly obeying the principles below.
- **`type: "transfer"`** ("New case") follows a passed direct check on the plan's goal/sink node(s). It pushes application to its limit: testing the generative structure against a genuinely new case, unfamiliar domain context, or boundary condition not used during the explanation, fully answerable by reasoning from the lesson.

Every check or transfer question exists to answer one question: did the idea actually **take** — not whether he can read it back. The principles:

- **Answerable by reasoning from the session.** Every check and transfer question must be answerable by reasoning from what the session has covered — never require outside trivia or anything he couldn't have deduced from the lesson itself. A question he has no route to is not a check, it's a coin flip.
- **Never just reciting your words back.** A question that only asks him to parrot the sentence just above it is copywork, not evidence.
- **Prefer problems that apply the knowledge.** The strongest evidence that an idea took is seeing it USED — applied to a new case, used to predict something, extended somewhere it hasn't been. Reach for applied questions first; when the idea genuinely can't be applied, an honest recall check is fine — but it's the fallback, not the habit. (For the lesson goal, `type: "transfer"` makes this application explicit with a genuinely fresh scenario).
- **Catch confusion early, and make it nameable.** Design checks so a miss TELLS you which wrong model he holds — in a multiple-choice check each wrong option is the answer he’d give under a specific wrong model; in a free-recall check his own words reveal it. Diagnose and repair before building anything on top of it.
- **His answer is signal, not verdict.** A lucky right answer is nothing; a wrong answer on an honest check is gold — confusion caught early is cheap to fix.
