const status = document.getElementById("status");

void chrome.runtime
  .sendMessage({ kind: "bue.status" })
  .then((reply: { connected: boolean; error?: string } | undefined) => {
    if (!status) return;
    if (reply?.connected) {
      status.innerHTML = '<span class="on">? Connected.</span> Agents can use this browser.';
      return;
    }
    status.innerHTML =
      '<span class="off">? Not connected.</span> Run <code>npx browserkit setup</code>, then reopen this popup.';
  });
