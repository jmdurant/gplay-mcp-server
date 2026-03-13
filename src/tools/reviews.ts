import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GooglePlayClient } from '../client.js';
import { formatError } from '../errors.js';

interface Review {
  reviewId: string;
  authorName: string;
  comments: Array<{
    userComment?: {
      text: string;
      lastModified: { seconds: string };
      starRating: number;
      device: string;
      androidOsVersion: number;
      appVersionCode: number;
      appVersionName: string;
    };
    developerComment?: {
      text: string;
      lastModified: { seconds: string };
    };
  }>;
}

interface ReviewsResponse {
  reviews: Review[];
  tokenPagination?: { nextPageToken: string };
}

export function registerReviewTools(server: McpServer, client: GooglePlayClient) {
  server.tool(
    'list_reviews',
    'List recent reviews for an app on Google Play',
    {
      packageName: z.string().describe('Android package name'),
      maxResults: z.number().optional().describe('Max reviews to return (default 20)'),
    },
    async ({ packageName, maxResults }) => {
      try {
        const params: Record<string, string> = {};
        if (maxResults) params['maxResults'] = String(maxResults);

        const reviews = await client.request<ReviewsResponse>(
          `/applications/${packageName}/reviews`,
          { params }
        );

        const formatted = (reviews.reviews ?? []).map(r => {
          const userComment = r.comments?.[0]?.userComment;
          return {
            reviewId: r.reviewId,
            author: r.authorName,
            rating: userComment?.starRating,
            text: userComment?.text,
            appVersion: userComment?.appVersionName,
            device: userComment?.device,
            hasReply: r.comments?.some(c => c.developerComment),
          };
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(formatted, null, 2) }] };
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.tool(
    'reply_to_review',
    'Reply to a user review on Google Play',
    {
      packageName: z.string().describe('Android package name'),
      reviewId: z.string().describe('Review ID (from list_reviews)'),
      replyText: z.string().describe('Your reply text'),
    },
    async ({ packageName, reviewId, replyText }) => {
      try {
        const result = await client.request(
          `/applications/${packageName}/reviews/${reviewId}:reply`,
          {
            method: 'POST',
            body: { replyText },
          }
        );

        return {
          content: [{
            type: 'text' as const,
            text: `Reply posted successfully.\n${JSON.stringify(result, null, 2)}`,
          }],
        };
      } catch (error) {
        return formatError(error);
      }
    }
  );
}
