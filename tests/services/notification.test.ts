/**
 * Tests for NotificationManager
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotificationManager, NotificationConfig, NotificationOptions, StaleItem } from '../../src/services/notification.js';
import { ActionItem, Question, Digest } from '../../src/services/analyzer.js';

describe('NotificationManager', () => {
  let notificationManager: NotificationManager;
  let config: NotificationConfig;
  let notificationHandler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    config = {
      enabled: true,
      actionItems: {
        enabled: true,
        priority: 'medium',
      },
      digest: {
        enabled: true,
        time: '09:00',
      },
      staleItems: {
        enabled: true,
        thresholdDays: 7,
      },
    };

    notificationManager = new NotificationManager(config);
    notificationHandler = vi.fn().mockResolvedValue(undefined);
    notificationManager.setNotificationHandler(notificationHandler);
  });

  describe('notifyActionItem', () => {
    it('should send notification for action item', async () => {
      const actionItem: ActionItem = {
        id: 'action-1',
        description: 'Complete code review',
        assignee: 'Alice',
        status: 'open',
        sourceMessageId: 'msg-1',
        confidence: 0.9,
        extractedAt: new Date(),
      };

      await notificationManager.notifyActionItem(actionItem);

      expect(notificationHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'New Action Item',
          message: expect.stringContaining('Complete code review'),
        })
      );
    });

    it('should include assignee in notification', async () => {
      const actionItem: ActionItem = {
        id: 'action-1',
        description: 'Update documentation',
        assignee: 'Bob',
        status: 'open',
        sourceMessageId: 'msg-1',
        confidence: 0.9,
        extractedAt: new Date(),
      };

      await notificationManager.notifyActionItem(actionItem);

      expect(notificationHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Bob'),
        })
      );
    });

    it('should include due date if present', async () => {
      const dueDate = new Date('2024-12-31');
      const actionItem: ActionItem = {
        id: 'action-1',
        description: 'Finish project',
        dueDate,
        status: 'open',
        sourceMessageId: 'msg-1',
        confidence: 0.9,
        extractedAt: new Date(),
      };

      await notificationManager.notifyActionItem(actionItem);

      expect(notificationHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Due:'),
        })
      );
    });

    it('should not notify when action items are disabled', async () => {
      config.actionItems.enabled = false;
      notificationManager = new NotificationManager(config);
      notificationManager.setNotificationHandler(notificationHandler);

      const actionItem: ActionItem = {
        id: 'action-1',
        description: 'Test',
        status: 'open',
        sourceMessageId: 'msg-1',
        confidence: 0.9,
        extractedAt: new Date(),
      };

      await notificationManager.notifyActionItem(actionItem);

      expect(notificationHandler).not.toHaveBeenCalled();
    });
  });

  describe('notifyActionItems', () => {
    it('should send single notification for one item', async () => {
      const actionItems: ActionItem[] = [
        {
          id: 'action-1',
          description: 'Test item',
          status: 'open',
          sourceMessageId: 'msg-1',
          confidence: 0.9,
          extractedAt: new Date(),
        },
      ];

      await notificationManager.notifyActionItems(actionItems);

      expect(notificationHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'New Action Item',
        })
      );
    });

    it('should send summary notification for multiple items', async () => {
      const actionItems: ActionItem[] = [
        {
          id: 'action-1',
          description: 'Task 1',
          assignee: 'Alice',
          status: 'open',
          sourceMessageId: 'msg-1',
          confidence: 0.9,
          extractedAt: new Date(),
        },
        {
          id: 'action-2',
          description: 'Task 2',
          status: 'open',
          sourceMessageId: 'msg-2',
          confidence: 0.9,
          extractedAt: new Date(),
        },
      ];

      await notificationManager.notifyActionItems(actionItems);

      expect(notificationHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '2 New Action Items',
          message: expect.stringContaining('assigned'),
        })
      );
    });

    it('should not notify for empty array', async () => {
      await notificationManager.notifyActionItems([]);
      expect(notificationHandler).not.toHaveBeenCalled();
    });
  });

  describe('notifyDailyDigest', () => {
    it('should send digest notification', async () => {
      const digest: Digest = {
        topic: 'Product Development',
        date: new Date('2024-01-01'),
        summary: 'Daily summary',
        actionItems: [],
        openQuestions: [],
        highlights: ['Highlight 1'],
        metrics: {
          totalMessages: 10,
          activeParticipants: 5,
          newActionItems: 2,
          completedActionItems: 1,
        },
      };

      await notificationManager.notifyDailyDigest(digest);

      expect(notificationHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Daily Digest: Product Development',
          message: expect.stringContaining('10 messages'),
        })
      );
    });

    it('should not notify when digest is disabled', async () => {
      config.digest.enabled = false;
      notificationManager = new NotificationManager(config);
      notificationManager.setNotificationHandler(notificationHandler);

      const digest: Digest = {
        topic: 'Test',
        date: new Date(),
        summary: 'Summary',
        actionItems: [],
        openQuestions: [],
        highlights: [],
        metrics: {
          totalMessages: 0,
          activeParticipants: 0,
          newActionItems: 0,
          completedActionItems: 0,
        },
      };

      await notificationManager.notifyDailyDigest(digest);

      expect(notificationHandler).not.toHaveBeenCalled();
    });
  });

  describe('notifyStaleItems', () => {
    it('should send notification for stale items', async () => {
      const staleItems: StaleItem[] = [
        {
          id: 'action-1',
          type: 'action_item',
          description: 'Old task',
          daysSinceCreated: 10,
          assignee: 'Alice',
        },
        {
          id: 'question-1',
          type: 'question',
          description: 'Unanswered question',
          daysSinceCreated: 8,
        },
      ];

      await notificationManager.notifyStaleItems(staleItems);

      expect(notificationHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Stale Items Need Attention',
          message: expect.stringContaining('7 days'),
        })
      );
    });

    it('should not notify for empty stale items', async () => {
      await notificationManager.notifyStaleItems([]);
      expect(notificationHandler).not.toHaveBeenCalled();
    });
  });

  describe('notifyOpenQuestions', () => {
    it('should send notification for single question', async () => {
      const questions: Question[] = [
        {
          id: 'question-1',
          question: 'What is the deployment date?',
          askedBy: 'Alice',
          askedAt: new Date(),
          answered: false,
          sourceMessageId: 'msg-1',
          confidence: 0.9,
        },
      ];

      await notificationManager.notifyOpenQuestions(questions);

      expect(notificationHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Unanswered Question',
          message: expect.stringContaining('What is the deployment date?'),
        })
      );
    });

    it('should send summary notification for multiple questions', async () => {
      const questions: Question[] = [
        {
          id: 'question-1',
          question: 'Question 1?',
          askedBy: 'Alice',
          askedAt: new Date(),
          answered: false,
          sourceMessageId: 'msg-1',
          confidence: 0.9,
        },
        {
          id: 'question-2',
          question: 'Question 2?',
          askedBy: 'Bob',
          askedAt: new Date(),
          answered: false,
          sourceMessageId: 'msg-2',
          confidence: 0.9,
        },
      ];

      await notificationManager.notifyOpenQuestions(questions);

      expect(notificationHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '2 Unanswered Questions',
        })
      );
    });
  });

  describe('notifySyncError', () => {
    it('should send notification for sync errors', async () => {
      await notificationManager.notifySyncError('Teams', 'Connection timeout');

      expect(notificationHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Sync Error: Teams',
          message: 'Connection timeout',
          sound: true,
        })
      );
    });
  });

  describe('updateConfig', () => {
    it('should update configuration', () => {
      notificationManager.updateConfig({
        actionItems: {
          enabled: false,
          priority: 'low',
        },
      });

      const updatedConfig = notificationManager.getConfig();
      expect(updatedConfig.actionItems.enabled).toBe(false);
      expect(updatedConfig.actionItems.priority).toBe('low');
    });
  });

  describe('checkStaleItems', () => {
    it('should identify and notify stale action items', async () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 10);

      const actionItems: ActionItem[] = [
        {
          id: 'action-1',
          description: 'Old task',
          status: 'open',
          sourceMessageId: 'msg-1',
          confidence: 0.9,
          extractedAt: oldDate,
        },
      ];

      const questions: Question[] = [];

      await notificationManager.checkStaleItems(actionItems, questions);

      expect(notificationHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Stale Items Need Attention',
        })
      );
    });

    it('should not notify for completed action items', async () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 10);

      const actionItems: ActionItem[] = [
        {
          id: 'action-1',
          description: 'Completed task',
          status: 'completed',
          sourceMessageId: 'msg-1',
          confidence: 0.9,
          extractedAt: oldDate,
        },
      ];

      const questions: Question[] = [];

      await notificationManager.checkStaleItems(actionItems, questions);

      expect(notificationHandler).not.toHaveBeenCalled();
    });

    it('should identify stale questions', async () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 10);

      const actionItems: ActionItem[] = [];

      const questions: Question[] = [
        {
          id: 'question-1',
          question: 'Old question?',
          askedBy: 'Alice',
          askedAt: oldDate,
          answered: false,
          sourceMessageId: 'msg-1',
          confidence: 0.9,
        },
      ];

      await notificationManager.checkStaleItems(actionItems, questions);

      expect(notificationHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Stale Items Need Attention',
        })
      );
    });
  });

  describe('scheduleDailyDigest', () => {
    it('should schedule daily digest', () => {
      const callback = vi.fn().mockResolvedValue({
        topic: 'Test',
        date: new Date(),
        summary: 'Summary',
        actionItems: [],
        openQuestions: [],
        highlights: [],
        metrics: {
          totalMessages: 0,
          activeParticipants: 0,
          newActionItems: 0,
          completedActionItems: 0,
        },
      });

      const timer = notificationManager.scheduleDailyDigest(callback);

      expect(timer).not.toBeNull();
      if (timer) {
        clearTimeout(timer);
      }
    });

    it('should return null when digest is disabled', () => {
      config.digest.enabled = false;
      notificationManager = new NotificationManager(config);

      const callback = vi.fn();
      const timer = notificationManager.scheduleDailyDigest(callback);

      expect(timer).toBeNull();
    });

    it('should return null for invalid time format', () => {
      config.digest.time = 'invalid';
      notificationManager = new NotificationManager(config);

      const callback = vi.fn();
      const timer = notificationManager.scheduleDailyDigest(callback);

      expect(timer).toBeNull();
    });
  });

  describe('disabled notifications', () => {
    it('should not send any notifications when globally disabled', async () => {
      config.enabled = false;
      notificationManager = new NotificationManager(config);
      notificationManager.setNotificationHandler(notificationHandler);

      const actionItem: ActionItem = {
        id: 'action-1',
        description: 'Test',
        status: 'open',
        sourceMessageId: 'msg-1',
        confidence: 0.9,
        extractedAt: new Date(),
      };

      await notificationManager.notifyActionItem(actionItem);

      expect(notificationHandler).not.toHaveBeenCalled();
    });
  });
});
