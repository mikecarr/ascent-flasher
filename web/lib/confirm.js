// Yes/no questions on one modal <dialog> whose <form method="dialog"> has
// submit buttons valued "ok" / "cancel". DOM objects are injected (Node tests).
//
// Each ask() is answered only by its own dialog session:
// - the submit is taken over (preventDefault + our own close), so the browser's
//   method=dialog close can't land after the next ask has opened;
// - no "close" listener at all: Chromium fires "close" later (on an animation
//   frame), and a stale one must never answer a later question;
// - Escape arrives as "cancel" and answers no.

export function makeAsk({ dialog, form, show }) {
  let pending = null; // settle function of the open ask

  return function ask(content) {
    pending?.(false); // a new question withdraws an unanswered one
    return new Promise((resolve) => {
      let settled = false;
      const settle = (ok) => {
        if (settled) return;
        settled = true;
        if (pending === settle) pending = null;
        form.removeEventListener("submit", onSubmit);
        dialog.removeEventListener("cancel", onCancel);
        if (dialog.open) dialog.close(ok ? "ok" : "cancel");
        resolve(ok);
      };
      const onSubmit = (e) => {
        e.preventDefault();
        settle(e.submitter?.value === "ok");
      };
      const onCancel = (e) => {
        e.preventDefault();
        settle(false);
      };
      pending = settle;
      show(content);
      dialog.returnValue = "";
      form.addEventListener("submit", onSubmit);
      dialog.addEventListener("cancel", onCancel);
      dialog.showModal();
    });
  };
}
