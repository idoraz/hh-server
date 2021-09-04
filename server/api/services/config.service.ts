import { Types as mongooseTypes } from 'mongoose';
import L from '../../common/logger';
import * as HttpStatus from 'http-status-codes';
import * as errors from '../../common/errors';
import { Config, IConfigModel } from '../models/config';
import { IHouseModel, House } from '../models/house';
const moment = require('moment');

export class ConfigService {
    async all(): Promise<IConfigModel[]> {
        L.info('fetch all configurations');

        const docs = (await Config.find().lean().exec()) as IConfigModel[];

        return docs;
    }

    async byId(id: string): Promise<IConfigModel> {
        L.info(`fetch configuration with id ${id}`);

        if (!mongooseTypes.ObjectId.isValid(id)) throw new errors.HttpError(HttpStatus.BAD_REQUEST);

        const doc = (await Config.findOne({ _id: id }).lean().exec()) as IConfigModel;

        if (!doc) throw new errors.HttpError(HttpStatus.NOT_FOUND);

        return doc;
    }

    async byKey(key: string): Promise<IConfigModel> {
        L.info(`fetch configuration with key ${key}`);

        const doc = (await Config.findOne({ key: key }).lean().exec()) as IConfigModel;

        return doc;
    }

    async create(configData: IConfigModel): Promise<IConfigModel> {
        L.info(`create configuration with data ${configData}`);

        const config = new Config(configData);
        const doc = (await config.save()) as IConfigModel;

        return doc;
    }

    async patch(id: string, configData: IConfigModel): Promise<IConfigModel> {
        L.info(`update configuration with id ${id} with data ${configData}`);

        const doc = (await Config.findOneAndUpdate({ _id: id }, { $set: configData }, { new: true })
            .lean()
            .exec()) as IConfigModel;

        return doc;
    }

    async remove(id: string): Promise<void> {
        L.info(`delete configuration with id ${id}`);

        return await Config.findOneAndRemove({ _id: id }).lean().exec();
    }

    async updateGlobalPPDate(auctionID: string): Promise<Date> {
        try {
            let dates: string[] = [];
            let config = (await Config.findOne({ key: 'globalPPDate' })
                .lean()
                .exec()) as IConfigModel;
            const houses = (await House.find({ auctionID: auctionID })
                .lean()
                .exec()) as IHouseModel[];

            if (!config) {
                throw new Error('Failed to find globalPPDate configuration');
            }

            houses.map((house) => {
                if (house.isPP && house.ppDate) {
                    dates.push(house.ppDate.toUTCString());
                }
            });
            config.value = new Date(this.findMaxOccurnces(dates));
            config = await this.patch(config._id, config);
            return config.value;
        } catch (error) {
            console.log(error);
            return new Date();
        }
    }

    findMaxOccurnces(array) {
        if (array.length == 0) return null;
        const modeMap = {};
        let maxEl = array[0],
            maxCount = 1;
        for (let i = 0; i < array.length; i++) {
            const el = array[i];
            if (modeMap[el] == null) modeMap[el] = 1;
            else modeMap[el]++;
            if (modeMap[el] > maxCount) {
                maxEl = el;
                maxCount = modeMap[el];
            }
        }
        return maxEl;
    }

    async setCurrentAuctionID(auctionID: string): Promise<string> {
        if (!auctionID) return;
        const keyName = 'currentAuctionID';

        let config = await this.byKey(keyName);
        if (!config) {
            config = new Config({ key: keyName, value: auctionID });
            await this.create(config);
        } else {
            if (auctionID !== config.value) {
                config.value = auctionID;
                await this.patch(config._id, config);
            }
        }

        return auctionID;
    }
}

export default new ConfigService();
