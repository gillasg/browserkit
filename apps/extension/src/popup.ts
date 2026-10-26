const status = document.getElementById("status");

void chrome.runtime
  .sendMessage({ kind: "bue.status" })
  .then((reply: { connected: boolean; error?: string } | undefined) => {
    if (!status) return;
    if (reply?.connected) {
      status.innerHTML = '<span class="on">● Connected.</span> Agents can use this browser.';
      return;
    }
    status.innerHTML =
      '<span class="off">● Not connected.</span> Run <code>npx browserkit setup</code>, then reopen this popup.';
  });
const share = document.getElementById("share") as HTMLButtonElement | null;
const shareState = document.getElementById("share-state");
const requestedTab = Number(new URLSearchParams(location.search).get("tab") ?? 0);
void chrome.tabs.query({ active: true, currentWindow: true }).then(async ([active]) => {
  const tabId = requestedTab || active?.id;
  if (!tabId || !share || !shareState) return;
  const state = await chrome.runtime.sendMessage({ kind: "bue.tabState", tabId });
  const update = () => {
    share.textContent = state?.shared ? "Stop sharing this tab" : "Hand this tab to agents";
    shareState.textContent = state?.shared ? "Shared with agents" : "";
  };
  update();
  share.disabled = false;
  share.onclick = async () => {
    const next = await chrome.runtime.sendMessage({ kind: "bue.shareTab", tabId });
    state.shared = Boolean(next?.shared);
    update();
  };
});
