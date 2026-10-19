export function setStatusBox(statusBox, node, fill) {
  statusBox.textContent = '';
  statusBox.classList.toggle('status-fill', !!fill);
  if (node) statusBox.appendChild(node);
}
