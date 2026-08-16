// Work Intelligence - Teams Collector (Read-Only)
// Security: Cannot post, click, or modify - only reads visible data

(function() {
  'use strict';

  const CONFIG = {
    LOCAL_SERVER: 'http://localhost:3001/api/ingest',
    COLLECTION_INTERVAL: 30000, // 30 seconds
    MAX_MESSAGES_PER_BATCH: 50,
    ENABLED: true
  };

  // Security Policy - Enforced
  const SECURITY_POLICY = {
    READ_ONLY: true,
    NO_POST: true,
    NO_CLICK: true,
    NO_INPUT: true,
    VERSION: '1.0.0'
  };

  class TeamsCollector {
    constructor() {
      this.collectedIds = new Set();
      this.collectTimeout = null;
      console.log('🔒 Teams Collector initialized (read-only mode)');
    }

    extractMessages() {
      const messages = [];

      try {
        // Teams message selectors (multiple for compatibility)
        const selectors = [
          '[data-tid="message-container"]',
          '.ui-chat__message',
          '.fui-ChatMessage',
          '[role="listitem"][class*="message"]'
        ];

        let messageElements = [];
        for (const selector of selectors) {
          const elements = document.querySelectorAll(selector);
          if (elements.length > 0) {
            messageElements = Array.from(elements);
            break;
          }
        }

        messageElements.forEach((element, index) => {
          try {
            const messageId = element.getAttribute('data-id')
              || element.getAttribute('id')
              || `teams-msg-${Date.now()}-${index}`;

            if (this.collectedIds.has(messageId)) return;

            // Extract sender
            const senderSelectors = [
              '[data-tid="message-author-name"]',
              '.ui-chat__message__author',
              '.fui-ChatMessage__author',
              '[class*="author"]'
            ];

            let sender = 'Unknown';
            for (const sel of senderSelectors) {
              const element = document.querySelector(sel);
              if (element?.textContent?.trim()) {
                sender = element.textContent.trim();
                break;
              }
            }

            // Extract content
            const contentSelectors = [
              '[data-tid="message-body-content"]',
              '.ui-chat__message__body',
              '.fui-ChatMessage__body',
              '[class*="message-body"]',
              'p'
            ];

            let content = '';
            for (const sel of contentSelectors) {
              const el = element.querySelector(sel);
              if (el?.textContent?.trim()) {
                content = el.textContent.trim();
                break;
              }
            }

            // Extract timestamp
            const timeSelectors = [
              '[data-tid="message-timestamp"]',
              'time',
              '.fui-ChatMessage__timestamp',
              '[class*="timestamp"]'
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

            const channelName = this.extractChannelName();

            if (content && content.length > 3) {
              messages.push({
                id: messageId,
                source: 'teams',
                sender,
                content,
                timestamp,
                channel: channelName,
                url: window.location.href
              });

              this.collectedIds.add(messageId);
            }
          } catch (error) {
            console.warn('Failed to extract message:', error);
          }
        });

        return messages.slice(0, CONFIG.MAX_MESSAGES_PER_BATCH);
      } catch (error) {
        console.error('TeamsCollector: Failed to extract messages:', error);
        return [];
      }
    }

    extractChannelName() {
      try {
        const selectors = [
          '[data-tid="channel-name"]',
          '.ui-chat__header__title',
          'h1',
          '[class*="channel-name"]'
        ];

        for (const selector of selectors) {
          const element = document.querySelector(selector);
          if (element?.textContent?.trim()) {
            return element.textContent.trim();
          }
        }

        return 'Unknown Channel';
      } catch {
        return 'Unknown Channel';
      }
    }

    async sendToLocalServer(messages) {
      if (!CONFIG.ENABLED || messages.length === 0) return;

      try {
        const response = await fetch(CONFIG.LOCAL_SERVER, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Extension-Version': SECURITY_POLICY.VERSION,
            'X-Security-Policy': JSON.stringify(SECURITY_POLICY)
          },
          body: JSON.stringify({
            source: 'teams',
            messages,
            timestamp: Date.now(),
            security: SECURITY_POLICY
          })
        });

        if (response.ok) {
          const result = await response.json();
          console.log(`✅ Sent ${messages.length} messages, inserted ${result.inserted}`);
        } else {
          console.warn('⚠️ Local server returned error:', response.status);
        }
      } catch (error) {
        console.warn('⚠️ Cannot connect to local server:', error.message);
      }
    }

    collect() {
      if (!CONFIG.ENABLED) return;

      const messages = this.extractMessages();
      if (messages.length > 0) {
        console.log(`📥 Collected ${messages.length} Teams messages`);
        this.sendToLocalServer(messages);
      }
    }

    observeNewMessages() {
      const observer = new MutationObserver((mutations) => {
        const hasNewMessages = mutations.some(mutation =>
          Array.from(mutation.addedNodes).some(node =>
            node.nodeType === 1 &&
            (node.matches?.('[data-tid="message-container"]') ||
             node.querySelector?.('[data-tid="message-container"]'))
          )
        );

        if (hasNewMessages) {
          clearTimeout(this.collectTimeout);
          this.collectTimeout = setTimeout(() => this.collect(), 2000);
        }
      });

      const chatSelectors = [
        '[data-tid="chat-canvas"]',
        '.ui-chat__messagelist',
        '[role="main"]',
        '[class*="message-list"]'
      ];

      for (const selector of chatSelectors) {
        const container = document.querySelector(selector);
        if (container) {
          observer.observe(container, {
            childList: true,
            subtree: true
          });
          console.log(`👀 Observing: ${selector}`);
          break;
        }
      }
    }

    start() {
      console.log('🚀 Teams Collector started (read-only mode)');
      console.log('🔒 Security: READ_ONLY mode - cannot post or modify');

      // Initial collection
      setTimeout(() => this.collect(), 5000);

      // Periodic collection
      setInterval(() => this.collect(), CONFIG.COLLECTION_INTERVAL);

      // Observe for new messages
      this.observeNewMessages();
    }
  }

  // Initialize when page is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      const collector = new TeamsCollector();
      collector.start();
    });
  } else {
    const collector = new TeamsCollector();
    collector.start();
  }

  // Listen for manual trigger
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'collectNow') {
      const collector = new TeamsCollector();
      collector.collect();
      sendResponse({ status: 'collected' });
    }
  });
})();
