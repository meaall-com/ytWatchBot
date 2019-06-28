import arrayDifferent from "./tools/arrayDifferent";
import LogFile from "./logFile";
import roundStartInterval from "./tools/roundStartInterval";
import getInProgress from "./tools/getInProgress";

const debug = require('debug')('app:Checker');
const promiseLimit = require('promise-limit');

const oneLimit = promiseLimit(1);

class Checker {
  constructor(/**Main*/main) {
    this.main = main;
    this.log = new LogFile('checker');
  }

  init() {
    this.startUpdateInterval();
    this.startCleanInterval();
  }

  updateIntervalId = null;
  startUpdateInterval() {
    clearInterval(this.updateIntervalId);
    this.updateIntervalId = roundStartInterval(() => {
      this.updateIntervalId = setInterval(() => {
        this.check();
      }, 5 * 60 * 1000);
      this.check();
    });
  }

  cleanIntervalId = null;
  startCleanInterval() {
    clearInterval(this.cleanIntervalId);
    this.cleanIntervalId = setInterval(() => {
      this.clean();
    }, 60 * 60 * 1000);
  }

  inProgress = getInProgress();

  check() {
    return this.inProgress(() => oneLimit(async () => {
      while (true) {
        const channels = await this.main.db.getChannelsForSync(50);
        if (!channels.length) {
          break;
        }

        const channelIdChannel = new Map();
        const channelIds = [];
        const rawChannels = [];

        const defaultDate = new Date();
        defaultDate.setDate(defaultDate.getDate() - 7);

        channels.forEach(channel => {
          channelIds.push(channel.id);
          channelIdChannel.set(channel.id, channel);

          let publishedAfter = null;
          if (channel.lastVideoPublishedAt) {
            publishedAfter = new Date(channel.lastVideoPublishedAt.getTime() + 1000);
          }
          if (!publishedAfter) {
            publishedAfter = channel.lastSyncAt;
          }
          if (!publishedAfter || publishedAfter.getTime() < defaultDate.getTime()) {
            publishedAfter = defaultDate;
          }

          rawChannels.push({
            id: channel.rawId,
            publishedAfter: publishedAfter
          });
        });

        const syncAt = new Date();
        await this.main.db.setChannelsSyncTimeoutExpiresAtAndUncheckChanges(channelIds, 5).then(() => {
          return this.main.youtube.getVideos(rawChannels);
        }).then(({videos: rawVideos, videoIdChannelIds: rawVideoIdRawChannelIds, skippedChannelIds: skippedRawChannelIds}) => {
          const videoIdVideo = new Map();
          const videoIds = [];
          const newChannels = [];

          const videoIdChannelIds = new Map();
          rawVideoIdRawChannelIds.forEach((rawChannelIds, rawId) => {
            const id = this.main.db.model.Channel.buildId('youtube', rawId);
            videoIdChannelIds.set(id, rawChannelIds.map((rawChannelId) => {
              return this.main.db.model.Channel.buildId('youtube', rawChannelId);
            }));
          });

          rawVideos.forEach((video) => {
            const rawChannelId = video.channelId;
            video.id = this.main.db.model.Channel.buildId('youtube', video.id);
            video.channelId = this.main.db.model.Channel.buildId('youtube', video.channelId);

            if (!channelIdChannel.has(video.channelId)) {
              const channelIds = videoIdChannelIds.get(video.id);

              let linkedChannelId = null;
              channelIds.some((channelId) => {
                return linkedChannelId = channelId;
              });

              const channel = {
                id: video.channelId,
                service: 'youtube',
                title: video.channelTitle,
                url: this.main.youtube.getChannelUrl(rawChannelId),
                linkedChannelId: linkedChannelId
              };

              newChannels.push(channel);
              channelIdChannel.set(video.channelId, this.main.db.buildChannel(channel));
            }

            videoIdVideo.set(video.id, video);
            videoIds.push(video.id);
          });

          const checkedChannelIds = channelIds.slice(0);
          skippedRawChannelIds.forEach((rawId) => {
            const id = this.main.db.model.Channel.buildId('youtube', rawId);
            const pos = checkedChannelIds.indexOf(id);
            if (pos !== -1) {
              checkedChannelIds.splice(pos, 1);
            }
          });

          return this.main.db.getExistsVideoIds(videoIds).then((existsVideoIds) => {
            const videos = arrayDifferent(videoIds, existsVideoIds).map(id => videoIdVideo.get(id));
            return {
              videos,
              videoIdChannelIds,
              newChannels,
              channelIds: checkedChannelIds,
            }
          });
        }).then(({videos, videoIdChannelIds, newChannels, channelIds}) => {
          const channelIdsChanges = {};
          const channelIdVideoIds = new Map();

          channelIds.forEach((id) => {
            const channel = channelIdChannel.get(id);
            channelIdsChanges[id] = Object.assign({}, channel.get({plain: true}), {
              lastSyncAt: syncAt
            });
          });

          videos.forEach((video) => {
            videoIdChannelIds.get(video.id).forEach((channelId) => {
              const channel = channelIdChannel.get(channelId);
              const channelChanges = channelIdsChanges[channel.id];

              const title = channelChanges.title || channel.title;
              if (video.channelId === channelId && title !== video.channelTitle) {
                channelChanges.title = video.channelTitle;
              }

              const lastVideoPublishedAt = channelChanges.lastVideoPublishedAt || channel.lastVideoPublishedAt;
              if (!lastVideoPublishedAt || lastVideoPublishedAt.getTime() < video.publishedAt.getTime()) {
                channelChanges.lastVideoPublishedAt = video.publishedAt;
              }

              let channelVideoIds = channelIdVideoIds.get(channelId);
              if (!channelVideoIds) {
                channelIdVideoIds.set(channelId, channelVideoIds = []);
              }
              channelVideoIds.push(video.id);
            });
          });

          return this.main.db.getChatIdChannelIdByChannelIds(channelIds).then((chatIdChannelIdList) => {
            const channelIdChatIds = new Map();
            chatIdChannelIdList.forEach((chatIdChannelId) => {
              let chatIds = channelIdChatIds.get(chatIdChannelId.channelId);
              if (!chatIds) {
                channelIdChatIds.set(chatIdChannelId.channelId, chatIds = []);
              }
              if (!chatIdChannelId.chat.channelId || !chatIdChannelId.chat.isMuted) {
                chatIds.push(chatIdChannelId.chat.id);
              }
              if (chatIdChannelId.chat.channelId) {
                chatIds.push(chatIdChannelId.chat.channelId);
              }
            });

            const chatIdVideoIdChanges = [];
            for (const [channelId, chatIds] of channelIdChatIds.entries()) {
              const videoIds = channelIdVideoIds.get(channelId);
              if (videoIds) {
                videoIds.forEach((videoId) => {
                  chatIds.forEach((chatId) => {
                    chatIdVideoIdChanges.push({chatId, videoId});
                  });
                });
              }
            }

            const channelsChanges = Object.values(channelIdsChanges);

            return this.main.db.putVideos(newChannels, channelsChanges, videos, chatIdVideoIdChanges).then(() => {
              videos.forEach((video) => {
                this.log.write(`[insert] ${video.channelId} ${video.id}`);
              });

              if (videos.length) {
                this.main.sender.checkThrottled();
              }

              return {
                channelsChangesCount: channelsChanges.length,
                videosCount: videos.length,
                chatIdVideoIdChangesCount: chatIdVideoIdChanges.length,
              };
            });
          });
        });
      }
    }));
  }

  clean() {
    return oneLimit(() => {
      return Promise.all([
        this.main.db.cleanChats().then((chatsCount) => {
          return this.main.db.cleanChannels().then((channelsCount) => {
            return [chatsCount, channelsCount];
          });
        }),
        this.main.db.cleanVideos()
      ]).then(([[removedChats, removedChannels], removedVideos]) => {
        return {removedChats, removedChannels, removedVideos};
      });
    });
  }
}

export default Checker;