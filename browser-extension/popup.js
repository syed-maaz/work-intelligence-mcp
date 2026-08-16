// Popup control panel logic

document.addEventListener('DOMContentLoaded', async () => {
  const statusEl = document.getElementById('status');
  const messageCountEl = document.getElementById('messageCount');
  const lastSyncEl = document.getElementById('lastSync');
  const serverStatusEl = document.getElementById('serverStatus');
  const collectNowBtn = document.getElementById('collectNow');
  const openSettingsBtn = document.getElementById('openSettings');

  // Check server connection
  async function checkConnection() {
    try {
      const response = await fetch('http://localhost:3001/api/health', {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });

      if (response.ok) {
        const data = await response.json();

        // Update UI - connected
        statusEl.className = 'status connected';
        statusEl.innerHTML = `
          <span class="status-icon">✅</span>
          <span class="status-text">Connected to local server</span>
        `;

        messageCountEl.textContent = data.totalMessages || 0;
        lastSyncEl.textContent = data.lastSync
          ? new Date(data.lastSync).toLocaleTimeString()
          : 'Never';
        serverStatusEl.textContent = 'Running';

        collectNowBtn.disabled = false;
      } else {
        throw new Error('Server not responding');
      }
    } catch (error) {
      // Update UI - disconnected
      statusEl.className = 'status disconnected';
      statusEl.innerHTML = `
        <span class="status-icon">❌</span>
        <span class="status-text">Local server not running</span>
      `;

      messageCountEl.textContent = '-';
      lastSyncEl.textContent = '-';
      serverStatusEl.textContent = 'Offline';

      collectNowBtn.disabled = true;
    }
  }

  // Collect now button
  collectNowBtn.addEventListener('click', async () => {
    collectNowBtn.textContent = 'Collecting...';
    collectNowBtn.disabled = true;

    try {
      // Send message to active tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (tab.url.includes('teams.microsoft.com') ||
          tab.url.includes('outlook.office')) {
        await chrome.tabs.sendMessage(tab.id, { action: 'collectNow' });

        // Wait a bit for collection
        setTimeout(async () => {
          await checkConnection();
          collectNowBtn.textContent = 'Collect Now';
          collectNowBtn.disabled = false;
        }, 2000);
      } else {
        alert('Please open Microsoft Teams or Outlook first.');
        collectNowBtn.textContent = 'Collect Now';
        collectNowBtn.disabled = false;
      }
    } catch (error) {
      console.error('Collection failed:', error);
      collectNowBtn.textContent = 'Collect Now';
      collectNowBtn.disabled = false;
      alert('Collection failed. Make sure you\'re on Teams or Outlook page.');
    }
  });

  // Settings button
  openSettingsBtn.addEventListener('click', () => {
    chrome.tabs.create({
      url: 'http://localhost:3001'
    });
  });

  // Initial check
  await checkConnection();

  // Check every 10 seconds
  setInterval(checkConnection, 10000);
});
