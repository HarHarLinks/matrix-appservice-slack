/*
Copyright 2019 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { BaseSlackHandler, ISlackEvent, ISlackMessageEvent, ISlackMessage, ISlackMessageTopic, SlackEventTypes } from "./BaseSlackHandler";
import { BridgedRoom } from "./BridgedRoom";
import { Main } from "./Main";
import { Logging } from "matrix-appservice-bridge";

const log = Logging.get("SlackEventHandler");

interface ISlackEventChannelRenamed extends ISlackEvent {
    // https://api.slack.com/events/channel_rename
    id: string;
    name: string;
    created: number;
}

interface ISlackEventTeamDomainChanged extends ISlackEvent {
    url: string;
    domain: string;
}

interface ISlackEventReaction extends ISlackEvent {
    // https://api.slack.com/events/reaction_added
    reaction: string;
    item: ISlackMessage;
}

const HTTP_OK = 200;

export type EventHandlerCallback = (status: number, body?: string, headers?: {[header: string]: string}) => void;

export class SlackEventHandler extends BaseSlackHandler {
    /**
     * SUPPORTED_EVENTS corresponds to the types of events
     * handled in `handle`. This is useful if you need to subscribe
     * to events in order to handle them.
     */
    protected static SUPPORTED_EVENTS: string[] = ["message", "reaction_added", "reaction_removed",
    "team_domain_change", "channel_rename", "user_typing"];
    constructor(main: Main) {
        super(main);
    }

    public onVerifyUrl(challenge: string, response: EventHandlerCallback) {
        response(
            HTTP_OK,
            JSON.stringify({challenge}),
            {"Content-Type": "application/json"},
        );
    }

    /**
     * Handles a slack event request.
     * @param ISlackEventParams
     */
    public async handle(event: SlackEventTypes, teamId: string, response: EventHandlerCallback) {
        try {
            log.debug("Received slack event:", event, teamId);

            const endTimer = this.main.startTimer("remote_request_seconds");
            // See https://api.slack.com/events-api#responding_to_events
            // We must respond within 3 seconds or it will be sent again!
            response(HTTP_OK, "OK");

            let err: string|null = null;
            try {
                switch (event.type) {
                    case "message":
                        await this.handleMessageEvent(event as ISlackMessageEvent, teamId);
                        break;
                    case "reaction_added":
                    case "reaction_removed":
                        await this.handleReaction(event as ISlackEventReaction, teamId);
                        break;
                    case "channel_rename":
                        await this.handleChannelRenameEvent(event as ISlackEventChannelRenamed);
                        break;
                    case "team_domain_change":
                        await this.handleDomainChangeEvent(event as ISlackEventTeamDomainChanged, teamId);
                        break;
                    case "user_typing":
                        await this.handleTyping(event, teamId);
                        break;
                    // XXX: Unused?
                    case "file_comment_added":
                    default:
                        err = "unknown_event";
                }
            } catch (ex) {
                log.warn("Didn't handle event:", ex);
                err = ex;
            }

            if (err === "unknown_channel") {
                const chanIdMix = `${event.channel} (${teamId})`;
                log.warn(`Ignoring message from unrecognised slack channel id: ${chanIdMix}`);
                this.main.incCounter("received_messages", {side: "remote"});
                endTimer({outcome: "dropped"});
                return;
            } else if (err === "unknown_event") {
                endTimer({outcome: "dropped"});
            } else if (err !== null) {
                endTimer({outcome: "fail"});
            }

            if (err === null) {
                endTimer({outcome: "success"});
            } else {
                log.error("Failed to handle slack event:", err);
            }
        } catch (e) {
            log.error("SlackEventHandler.handle failed:", e);
        }
    }

    /**
     * Attempts to handle the `message` event.
     *
     * Sends a message to Matrix if it understands enough of the message to do so.
     * Attempts to make the message as native-matrix feeling as it can.
     * @param ISlackEventParamsMessage The slack message event to handle.
     */
    protected async handleMessageEvent(event: ISlackMessageEvent, teamId: string) {
        const room = this.main.getRoomBySlackChannelId(event.channel) as BridgedRoom;
        if (!room) { throw new Error("unknown_channel"); }

        if (event.subtype === "bot_message" &&
            (!room.SlackBotId || event.bot_id === room.SlackBotId)) {
            return;
        }

        // Only count received messages that aren't self-reflections
        this.main.incCounter("received_messages", {side: "remote"});

        const token = room.AccessToken;

        const msg = Object.assign({}, event, {
            channel_id: event.channel,
            team_domain: room.SlackTeamDomain || room.SlackTeamId,
            team_id: teamId,
            user_id: event.user || event.bot_id,
        });

        // TODO: We cannot remove reactions yet, see https://github.com/matrix-org/matrix-appservice-slack/issues/154
        /* else if (params.event.type === "reaction_removed") {
            return room.onSlackReactionRemoved(msg);
        } */

        if (!room.SlackClient) {
            // If we can't look up more details about the message
            // (because we don't have a master token), but it has text,
            // just send the message as text.
            log.warn("no slack token for " + room.SlackTeamDomain || room.SlackChannelId);
            return room.onSlackMessage(msg, teamId);
        }

        // Handle topics
        if (msg.subtype === "channel_topic" || msg.subtype === "group_topic") {
            return room.onSlackTopic(msg as unknown as ISlackMessageTopic, teamId);
        }

        // Handle events with attachments like bot messages.
        if (msg.attachments) {
            for (const attachment of msg.attachments) {
                msg.text = attachment.fallback;
                msg.text = await this.doChannelUserReplacements(msg, msg.text!, room.SlackClient);
                return await room.onSlackMessage(msg, teamId);
            }
            if (msg.text === "") {
                return;
            }
            msg.text = msg.text;
        }

        // In this method we must standardise the message object so that
        // getGhostForSlackMessage works correctly.
        if (msg.subtype === "file_comment" && msg.comment) {
            msg.user_id = msg.comment.user;
        } else if (msg.subtype === "message_changed" && msg.message && msg.previous_message) {
            msg.user_id = msg.message.user;
            msg.text = msg.message.text;
            msg.previous_message.text = (await this.doChannelUserReplacements(
                msg, msg.previous_message!.text!, room.SlackClient)
            )!;

            // Check if the edit was sent by a bot
            if (msg.message.bot_id !== undefined) {
                // Check the edit wasn't sent by us
                if (msg.message.bot_id === room.SlackBotId) {
                    return;
                } else {
                    msg.user_id = msg.bot_id;
                }
            }
        } else if (msg.subtype === "message_deleted") {
            const originalEvent = await this.main.datastore.getEventBySlackId(msg.channel, msg.deleted_ts);
            if (originalEvent) {
                const botClient = this.main.botIntent.getClient();
                return botClient.redactEvent(originalEvent.roomId, originalEvent.eventId);
            }
        } else if (msg.subtype === "message_replied") {
            // Slack sends us one of these as well as a normal message event
            // when using RTM, so we ignore it.
            return;
        }

        if (!room.SlackClient) {
            // If we can't look up more details about the message
            // (because we don't have a master token), but it has text,
            // just send the message as text.
            log.warn("no slack token for " + room.SlackTeamDomain || room.SlackChannelId);
            return room.onSlackMessage(event, teamId);
        }

        let content: Buffer|undefined;

        if (msg.subtype === "file_share" && msg.file) {
            // we need a user token to be able to enablePublicSharing
            if (room.SlackClient) {
                // TODO check is_public when matrix supports authenticated media
                // https://github.com/matrix-org/matrix-doc/issues/701
                try {
                    msg.file = await this.enablePublicSharing(msg.file, room.SlackClient);
                    content = await this.fetchFileContent(msg.file);
                } catch {
                    // Couldn't get a shareable URL for the file, oh well.
                }
            }
        }

        msg.text = await this.doChannelUserReplacements(msg, msg.text!, room.SlackClient);
        return room.onSlackMessage(msg, teamId, content);
    }

    private async handleReaction(event: ISlackEventReaction, teamId: string) {
        // Reactions store the channel in the item
        const channel = event.item.channel;
        const room = this.main.getRoomBySlackChannelId(channel) as BridgedRoom;
        if (!room) { throw new Error("unknown_channel"); }

        const msg = Object.assign({}, event, {
            channel_id: channel,
            team_domain: room.SlackTeamDomain || room.SlackTeamId,
            team_id: teamId,
            user_id: event.user || event.bot_id,
        });

        if (event.type === "reaction_added") {
            return room.onSlackReactionAdded(msg, teamId);
        }

        // TODO: We cannot remove reactions yet, see https://github.com/matrix-org/matrix-appservice-slack/issues/154
        /* else if (params.event.type === "reaction_removed") {
            return room.onSlackReactionRemoved(msg);
        } */
    }

    private async handleDomainChangeEvent(event: ISlackEventTeamDomainChanged, teamId: string) {
        await Promise.all(this.main.getRoomsBySlackTeamId(teamId).map(async (room: BridgedRoom) => {
            room.SlackTeamDomain = event.domain;
            if (room.isDirty) {
                await this.main.datastore.upsertRoom(room);
            }
        }));
    }

    private async handleChannelRenameEvent(event: ISlackEventChannelRenamed) {
        // TODO test me. and do we even need this? doesn't appear to be used anymore
        const room = this.main.getRoomBySlackChannelId(event.id);
        if (!room) { throw new Error("unknown_channel"); }

        const channelName = `${room.SlackTeamDomain}.#${event.name}`;
        room.SlackChannelName = channelName;
        if (room.isDirty) {
            await this.main.datastore.upsertRoom(room);
        }
    }

    private async handleTyping(event: ISlackEvent, teamId: string) {
        const room = this.main.getRoomBySlackChannelId(event.channel);
        if (!room) { throw new Error("unknown_channel"); }
        const typingEvent = Object.assign({}, event, {
            channel_id: event.channel,
            team_domain: room.SlackTeamDomain || room.SlackTeamId,
            team_id: teamId,
            user_id: event.user || event.bot_id,
        });
        await room.onSlackTyping(typingEvent, teamId);
    }

}
