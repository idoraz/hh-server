import { Request, Response, NextFunction } from 'express';
import * as HttpStatus from 'http-status-codes';

import { IHouseModel } from './../../models/house';
import HousesService from '../../services/houses.service';
import ConfigService from './../../services/config.service';

export class Controller {
    async all(req: Request, res: Response, next: NextFunction) {
        try {
            const houses = await HousesService.all();
            return res.status(HttpStatus.OK).json(houses);
        } catch (err) {
            return next(err);
        }
    }

    async byId(req: Request, res: Response, next: NextFunction) {
        try {
            const doc = await HousesService.byId(req.params.auctionNumber);
            return res.status(HttpStatus.OK).json(doc);
        } catch (err) {
            return next(err);
        }
    }

    async create(req: Request, res: Response, next: NextFunction) {
        try {
            const doc = await HousesService.create(req.body);
            return res.status(HttpStatus.CREATED).location(`/api/v1/houses/${doc._id}`).json(doc);
        } catch (err) {
            return next(err);
        }
    }

    async patch(req: Request, res: Response, next: NextFunction) {
        try {
            const doc = await HousesService.patch(req.params.auctionNumber, req.body);
            return res.status(HttpStatus.OK).location(`/api/v1/houses/${doc._id}`).json(doc);
        } catch (err) {
            return next(err);
        }
    }

    async remove(req: Request, res: Response, next: NextFunction) {
        try {
            const doc = await HousesService.remove(req.params.auctionNumber);
            return res.status(HttpStatus.NO_CONTENT).send();
        } catch (err) {
            return next(err);
        }
    }

    async getHouses(req: Request, res: Response, next: NextFunction) {
        try {
            const houses = await HousesService.getHouses();
            HousesService.sendEmailNotification();
            return res.status(HttpStatus.OK).json(houses);
        } catch (err) {
            return next(err);
        }
    }

    async saveHouses(req: Request, res: Response, next: NextFunction) {
        try {
            HousesService.updateHouses(req.body.houses as IHouseModel[])
                .then((houses) => {
                    return houses;
                })
                .catch((error) => {
                    console.log(`Failed to update houses!`);
                    console.log(error.message);
                    return [];
                });
        } catch (error) {
            return next(error);
        }
    }

    async downloadMap(req: Request, res: Response, next: NextFunction) {
        try {
            try {
                const auctionID = await HousesService.getCurrentAuctionID();
                if (!auctionID) {
                    throw new Error('Unable to find current auctionID!');
                }
                const globalPPDate = await ConfigService.updateGlobalPPDate(auctionID);
                await HousesService.parseToKml(auctionID, globalPPDate);
            } catch (error) {}
            const fileObject = HousesService.downloadKMLfile();
            res.set('Access-Control-Expose-Headers', 'Content-Disposition');
            res.set('Content-Type', 'application/vnd.google-earth.kml+xml');
            res.set('Content-Length', fileObject.stat.size);
            res.set('Content-Disposition', fileObject.filename);
            return res.status(HttpStatus.OK).send(fileObject.fileToSend);
        } catch (error) {
            return next(error);
        }
    }
}

export default new Controller();
