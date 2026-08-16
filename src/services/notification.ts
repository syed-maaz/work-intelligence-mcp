/**
 * Notification Manager
 *
 * Handles macOS notifications for action items, digests, and stale items
 */

import { ActionItem, Question, Digest } from './analyzer.js';

export interface NotificationConfig {
  enabled: boolean;
  actionItems: {
    enabled: boolean;
    priority: 'low' | 'medium' | 'high';
  };
  digest: {
    enabled: boolean;
    time: string; // HH:MM format
  };
  staleItems: {
    enabled: boolean;
    thresholdDays: number;
  };
}

export interface NotificationOptions {
  title: string;
  message: string;
  sound?: boolean;
  actions?: string[];
}

export interface StaleItem {
  id: string;
  type: 'action_item' | 'question';
  description: string;
  daysSinceCreated: number;
  assignee?: string;
}

/**
 * Notification manager for macOS
 */
export class NotificationManager {
  private config: NotificationConfig;
  private notificationHandler?: (options: NotificationOptions) => Promise<void>;

  constructor(config: NotificationConfig) {
    this.config = config;
  }

  /**
   * Register a custom notification handler
   * Useful for testing or custom notification implementations
   */
  setNotificationHandler(handler: (options: NotificationOptions) => Promise<void>): void {
    this.notificationHandler = handler;
  }

  /**
   * Notify about a new action item
   */
  async notifyActionItem(item: ActionItem): Promise<void> {
    if (!this.config.enabled || !this.config.actionItems.enabled) {
      return;
    }

    const assigneeText = item.assignee ? ` (assigned to ${item.assignee})` : '';
    const dueDateText = item.dueDate ? ` - Due: ${item.dueDate.toLocaleDateString()}` : '';

    await this.sendNotification({
      title: 'New Action Item',
      message: `${item.description}${assigneeText}${dueDateText}`,
      sound: this.config.actionItems.priority === 'high',
      actions: ['View', 'Dismiss'],
    });
  }

  /**
   * Notify about multiple action items
   */
  async notifyActionItems(items: ActionItem[]): Promise<void> {
    if (!this.config.enabled || !this.config.actionItems.enabled || items.length === 0) {
      return;
    }

    if (items.length === 1) {
      await this.notifyActionItem(items[0]);
      return;
    }

    const assignedCount = items.filter((item) => item.assignee).length;
    const unassignedCount = items.length - assignedCount;

    await this.sendNotification({
      title: `${items.length} New Action Items`,
      message: `${assignedCount} assigned, ${unassignedCount} unassigned`,
      sound: this.config.actionItems.priority === 'high',
      actions: ['View All', 'Dismiss'],
    });
  }

  /**
   * Notify about the daily digest
   */
  async notifyDailyDigest(digest: Digest): Promise<void> {
    if (!this.config.enabled || !this.config.digest.enabled) {
      return;
    }

    const { metrics } = digest;
    const summary = [
      `${metrics.totalMessages} messages`,
      `${metrics.newActionItems} new action items`,
      `${digest.openQuestions.length} open questions`,
    ].join(' • ');

    await this.sendNotification({
      title: `Daily Digest: ${digest.topic}`,
      message: summary,
      sound: false,
      actions: ['View Digest', 'Dismiss'],
    });
  }

  /**
   * Notify about stale items
   */
  async notifyStaleItems(items: StaleItem[]): Promise<void> {
    if (!this.config.enabled || !this.config.staleItems.enabled || items.length === 0) {
      return;
    }

    const actionItemCount = items.filter((item) => item.type === 'action_item').length;
    const questionCount = items.filter((item) => item.type === 'question').length;

    const parts: string[] = [];
    if (actionItemCount > 0) {
      parts.push(`${actionItemCount} action item${actionItemCount === 1 ? '' : 's'}`);
    }
    if (questionCount > 0) {
      parts.push(`${questionCount} question${questionCount === 1 ? '' : 's'}`);
    }

    await this.sendNotification({
      title: 'Stale Items Need Attention',
      message: `${parts.join(' and ')} older than ${this.config.staleItems.thresholdDays} days`,
      sound: true,
      actions: ['View Items', 'Dismiss'],
    });
  }

  /**
   * Notify about open questions
   */
  async notifyOpenQuestions(questions: Question[]): Promise<void> {
    if (!this.config.enabled || questions.length === 0) {
      return;
    }

    if (questions.length === 1) {
      const question = questions[0];
      await this.sendNotification({
        title: 'Unanswered Question',
        message: `${question.askedBy}: ${question.question}`,
        sound: false,
        actions: ['View', 'Dismiss'],
      });
      return;
    }

    await this.sendNotification({
      title: `${questions.length} Unanswered Questions`,
      message: 'Multiple questions need attention',
      sound: false,
      actions: ['View All', 'Dismiss'],
    });
  }

  /**
   * Notify about sync errors
   */
  async notifySyncError(source: string, error: string): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    await this.sendNotification({
      title: `Sync Error: ${source}`,
      message: error,
      sound: true,
      actions: ['Retry', 'Dismiss'],
    });
  }

  /**
   * Send a custom notification
   */
  async notify(options: NotificationOptions): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    await this.sendNotification(options);
  }

  /**
   * Update notification configuration
   */
  updateConfig(config: Partial<NotificationConfig>): void {
    this.config = {
      ...this.config,
      ...config,
      actionItems: {
        ...this.config.actionItems,
        ...(config.actionItems || {}),
      },
      digest: {
        ...this.config.digest,
        ...(config.digest || {}),
      },
      staleItems: {
        ...this.config.staleItems,
        ...(config.staleItems || {}),
      },
    };
  }

  /**
   * Get current configuration
   */
  getConfig(): NotificationConfig {
    return { ...this.config };
  }

  /**
   * Send notification using registered handler or built-in method
   */
  private async sendNotification(options: NotificationOptions): Promise<void> {
    if (this.notificationHandler) {
      await this.notificationHandler(options);
      return;
    }

    // Use macOS osascript for native notifications
    await this.sendMacOSNotification(options);
  }

  /**
   * Send macOS notification using osascript
   */
  private async sendMacOSNotification(options: NotificationOptions): Promise<void> {
    try {
      const { title, message, sound = false } = options;

      // In a real implementation, you would use child_process.exec to run osascript
      // For now, we'll just log it
      console.log('[Notification]', { title, message, sound });

      // Example implementation:
      // const escapedTitle = title.replace(/"/g, '\\"');
      // const escapedMessage = message.replace(/"/g, '\\"');
      // const soundOption = sound ? ' sound name "default"' : '';
      // exec(`osascript -e 'display notification "${escapedMessage}" with title "${escapedTitle}"${soundOption}'`);
    } catch (error) {
      console.error('Failed to send notification:', error);
    }
  }

  /**
   * Schedule daily digest notification
   */
  scheduleDailyDigest(callback: () => Promise<Digest | null>): NodeJS.Timeout | null {
    if (!this.config.enabled || !this.config.digest.enabled) {
      return null;
    }

    const [hours, minutes] = this.config.digest.time.split(':').map(Number);

    if (isNaN(hours) || isNaN(minutes)) {
      console.error('Invalid digest time format. Expected HH:MM');
      return null;
    }

    const scheduleNext = (): NodeJS.Timeout => {
      const now = new Date();
      const scheduledTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0);

      // If the time has passed today, schedule for tomorrow
      if (scheduledTime <= now) {
        scheduledTime.setDate(scheduledTime.getDate() + 1);
      }

      const delay = scheduledTime.getTime() - now.getTime();

      return setTimeout(async () => {
        try {
          const digest = await callback();
          if (digest) {
            await this.notifyDailyDigest(digest);
          }
        } catch (error) {
          console.error('Failed to generate digest for notification:', error);
        }

        // Schedule next day
        scheduleNext();
      }, delay);
    };

    return scheduleNext();
  }

  /**
   * Check for stale items and notify
   */
  async checkStaleItems(
    actionItems: ActionItem[],
    questions: Question[]
  ): Promise<void> {
    if (!this.config.enabled || !this.config.staleItems.enabled) {
      return;
    }

    const thresholdDate = new Date();
    thresholdDate.setDate(thresholdDate.getDate() - this.config.staleItems.thresholdDays);

    const staleItems: StaleItem[] = [];

    // Check action items
    for (const item of actionItems) {
      if (item.status !== 'completed' && item.extractedAt < thresholdDate) {
        const daysSinceCreated = Math.floor(
          (Date.now() - item.extractedAt.getTime()) / (1000 * 60 * 60 * 24)
        );

        staleItems.push({
          id: item.id,
          type: 'action_item',
          description: item.description,
          daysSinceCreated,
          assignee: item.assignee,
        });
      }
    }

    // Check questions
    for (const question of questions) {
      if (!question.answered && question.askedAt < thresholdDate) {
        const daysSinceCreated = Math.floor(
          (Date.now() - question.askedAt.getTime()) / (1000 * 60 * 60 * 24)
        );

        staleItems.push({
          id: question.id,
          type: 'question',
          description: question.question,
          daysSinceCreated,
        });
      }
    }

    if (staleItems.length > 0) {
      await this.notifyStaleItems(staleItems);
    }
  }
}
