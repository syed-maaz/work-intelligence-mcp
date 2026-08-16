// Work Intelligence - Outlook Collector (Read-Only)
// Security: Cannot post, click, or modify - only reads visible data

(function() {
  'use strict';

  const CONFIG = {
    LOCAL_SERVER: 'http://localhost:3001/api/ingest',
    COLLECTION_INTERVAL: 60000, // 1 minute
    MAX_EMAILS_PER_BATCH: 20,
    ENABLED: true
  };

  const SECURITY_POLICY = {
    READ_ONLY: true,
    NO_POST: true,
    NO_CLICK: true,
    NO_INPUT: true,
    VERSION: '1.0.0'
  };

  class OutlookCollector {
    constructor() {
      this.collectedIds = new Set();
      this.collectTimeout = null;
      console.log('🔒 Outlook Collector initialized (read-only mode)');
    }

    extractEmails() {
      const emails = [];

      try {
        // Outlook message selectors
        const selectors = [
          '[role="listitem"][data-convid]',
          '[role="option"][data-is-focusable="true"]',
          '[class*="message-item"]',
          '[data-automation-id="MessageListItem"]'
        ];

        let emailElements = [];
        for (const selector of selectors) {
          const elements = document.querySelectorAll(selector);
          if (elements.length > 0) {
            emailElements = Array.from(elements);
            break;
          }
        }

        emailElements.forEach((element, index) => {
          try {
            const emailId = element.getAttribute('data-convid')
              || element.getAttribute('id')
              || element.getAttribute('data-id')
              || `email-${Date.now()}-${index}`;

            if (this.collectedIds.has(emailId)) return;

            // Extract sender
            const senderSelectors = [
              '[title*="@"]',
              '.customScrollBar span[title]',
              '[data-automation-id="message-sender"]',
              '[class*="sender"]'
            ];

            let sender = 'Unknown';
            for (const sel of senderSelectors) {
              const el = element.querySelector(sel);
              const text = el?.textContent?.trim() || el?.getAttribute('title');
              if (text) {
                sender = text;
                break;
              }
            }

            // Extract subject
            const subjectSelectors = [
              '[data-automation-id="message-subject"]',
              '.customScrollBar > span > span',
              '[class*="subject"]',
              'span[title]'
            ];

            let subject = 'No subject';
            for (const sel of subjectSelectors) {
              const el = element.querySelector(sel);
              if (el?.textContent?.trim()) {
                subject = el.textContent.trim();
                break;
              }
            }

            // Extract preview/content
            const previewSelectors = [
              '[data-automation-id="message-preview"]',
              '[class*="preview"]',
              '[class*="body"]'
            ];

            let content = '';
            for (const sel of previewSelectors) {
              const el = element.querySelector(sel);
              if (el?.textContent?.trim()) {
                content = el.textContent.trim();
                break;
              }
            }

            // Extract timestamp
            const timeSelectors = [
              '[data-automation-id="message-time"]',
              'time',
              '[class*="timestamp"]',
              '[class*="date"]'
            ];

            let timestamp = new Date().toISOString();
            for (const sel of timeSelectors) {
              const el = element.querySelector(sel);
              const datetime = el?.getAttribute('datetime') || el?.textContent;
              if (datetime) {
                timestamp = datetime;
                break;
              }
            }

            const folder = this.extractFolderName();

            if (subject || content) {
              emails.push({
                id: emailId,
                source: 'email',
                sender,
                subject,
                content,
                timestamp,
                folder,
                url: window.location.href
              });

              this.collectedIds.add(emailId);
            }
          } catch (error) {
            console.warn('Failed to extract email:', error);
          }
        });

        return emails.slice(0, CONFIG.MAX_EMAILS_PER_BATCH);
      } catch (error) {
        console.error('OutlookCollector: Failed to extract emails:', error);
        return [];
      }
    }

    extractFolderName() {
      try {
        const selectors = [
          '[aria-label*="folder"]',
          '[data-automationid="FolderPaneHeaderText"]',
          '[class*="folder-name"]',
          'h2'
        ];

        for (const selector of selectors) {
          const element = document.querySelector(selector);
          if (element?.textContent?.trim()) {
            return element.textContent.trim();
          }
        }

        return 'Inbox';
      } catch {
        return 'Inbox';
      }
    }

    async sendToLocalServer(emails) {
      if (!CONFIG.ENABLED || emails.length === 0) return;

      try {
        const response = await fetch(CONFIG.LOCAL_SERVER, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Extension-Version': SECURITY_POLICY.VERSION,
            'X-Security-Policy': JSON.stringify(SECURITY_POLICY)
          },
          body: JSON.stringify({
            source: 'email',
            messages: emails,
            timestamp: Date.now(),
            security: SECURITY_POLICY
          })
        });

        if (response.ok) {
          const result = await response.json();
          console.log(`✅ Sent ${emails.length} emails, inserted ${result.inserted}`);
        } else {
          console.warn('⚠️ Local server returned error:', response.status);
        }
      } catch (error) {
        console.warn('⚠️ Cannot connect to local server:', error.message);
      }
    }

    collect() {
      if (!CONFIG.ENABLED) return;

      const emails = this.extractEmails();
      if (emails.length > 0) {
        console.log(`📥 Collected ${emails.length} emails`);
        this.sendToLocalServer(emails);
      }
    }

    observeNewEmails() {
      const observer = new MutationObserver(() => {
        clearTimeout(this.collectTimeout);
        this.collectTimeout = setTimeout(() => this.collect(), 3000);
      });

      const listSelectors = [
        '[role="list"]',
        '[data-automationid="MessageList"]',
        '[class*="message-list"]'
      ];

      for (const selector of listSelectors) {
        const list = document.querySelector(selector);
        if (list) {
          observer.observe(list, {
            childList: true,
            subtree: true
          });
          console.log(`👀 Observing: ${selector}`);
          break;
        }
      }
    }

    start() {
      console.log('🚀 Outlook Collector started (read-only mode)');
      console.log('🔒 Security: READ_ONLY mode - cannot post or modify');

      // Initial collection
      setTimeout(() => this.collect(), 5000);

      // Periodic collection
      setInterval(() => this.collect(), CONFIG.COLLECTION_INTERVAL);

      // Observe for new emails
      this.observeNewEmails();
    }
  }

  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      const collector = new OutlookCollector();
      collector.start();
    });
  } else {
    const collector = new OutlookCollector();
    collector.start();
  }

  // Listen for manual trigger
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'collectNow') {
      const collector = new OutlookCollector();
      collector.collect();
      sendResponse({ status: 'collected' });
    }
  });
})();
