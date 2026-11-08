# Fix Question Double-Submit and Raw JSON Error Leak Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent double-submission of question answers in the Question Dock and unwrap raw JSON 400 validation error responses so users never encounter spurious `{"error":"answer input targets no pending question call"}` banners.

**Architecture:** Remove redundant `onClick` handler on `<Button type="submit">` in `<QuestionDock>` and add a synchronous `submittingRef` lock to guarantee single-invocation semantics per question submission. In `SessionModel.send()`, parse and unwrap 400 `{ error: string }` responses for `input.type === "answer"` so user-facing errors show clean text instead of raw JSON.

**Tech Stack:** React 19, TypeScript, Next.js, Node test runner (`tsx --test`)

**Spec:** N/A (Bugfix addressing issue reported by user during session)

## Global Constraints

- Preserve all existing comments and docstrings in modified files.
- Run linter/formatter (`npm run typecheck`, `npm run lint`) and ensure all tests pass.
- Maintain single-submission guarantee across pointer clicks, Enter keydown, and dictation flush.

## Review Focus

1. Pointer click on "Submit answer" button dispatches `onSubmit` exactly once (no double-firing from `onClick` + form `submit`).
2. Rapid repeated Enter keypresses or double clicks do not dispatch multiple `submitAnswer` calls for the same question.
3. 400 Bad Request responses for `input.type === "answer"` unwrap the JSON `error` field into `Error.message` instead of throwing the raw JSON string.
4. Answering subsequent questions in the same session works reliably without stale error latching.

---

### Task 1: Fix QuestionDock double-submit and SessionCore 400 JSON unwrapping

**Owned Files:**
- `components/question-dock.tsx`
- `components/session-core.ts`

- [ ] **Step 1: Write failing tests**
  - In `tests/tool-content-interaction.test.tsx`, add a test verifying that calling `submit()` or clicking the submit button dispatches `onSubmit` exactly once even when both click and form submit events fire.
  - In `tests/session-core.test.ts`, add a test verifying that when `postInputEvent` receives a 400 status with body `{"error":"answer input targets no pending question call"}`, `send()` unwraps the error message to `"answer input targets no pending question call"`.

- [ ] **Step 2: Run tests to verify failure**
  - Run `NODE_ENV=test npx tsx --test tests/tool-content-interaction.test.tsx tests/session-core.test.ts` to confirm new tests fail or demonstrate current behavior.

- [ ] **Step 3: Implement QuestionDock single-submission guard**
  - In `components/question-dock.tsx`:
    - Remove `onClick={() => submit()}` from `<Button type="submit">` (line 1021). Form submit (`<form onSubmit={(e) => { e.preventDefault(); submit(); }}>`) is the sole trigger for the submit button.
    - Add `const submittingRef = useRef(false);` and check `if (submittingRef.current) return;` at the beginning of `submit()`.
    - Set `submittingRef.current = true;` when executing `doSubmit()`.
    - Reset `submittingRef.current = false;` if `toolCallId` changes or draft is reset.

- [ ] **Step 4: Implement SessionCore 400 JSON unwrapping for answer inputs**
  - In `components/session-core.ts`:
    - In `send()`, update lines 788-793 to also unwrap `input.type === "answer"` when `res.status === 400`:
      ```typescript
      if ((input.type === "retry" || input.type === "retry-question" || input.type === "answer" || (input.type === "text" && input.attachments?.length)) && res.status === 400) {
          try {
              const refusal = JSON.parse(message) as { error?: unknown } | null;
              if (typeof refusal?.error === "string" && refusal.error.length > 0) message = refusal.error;
          } catch { /* Non-envelope failures keep their original text. */ }
      }
      ```

- [ ] **Step 5: Verify all tests pass and run linter**
  - Run `NODE_ENV=test npx tsx --test tests/tool-content-interaction.test.tsx tests/session-core.test.ts`
  - Run `npm run typecheck`
  - Run `npm run lint`

- [ ] **Step 6: Commit changes**
  - Commit the fix with a descriptive commit message.
