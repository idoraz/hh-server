import L from '../../common/logger';
import * as HttpStatus from 'http-status-codes';
import * as errors from '../../common/errors';
import * as fs from 'fs';
import * as _ from 'lodash';
import path from 'path';
import PDFParser from 'pdf2json';
import download from 'download';
import JSONStream from 'JSONStream';
import Zillow from 'node-zillow';
import NodeGeocoder from 'node-geocoder';
const moment = require('moment');
const { promisify } = require('util');
const writeFile = promisify(fs.writeFile);
const excelToJson = require('convert-excel-to-json');
const tinyReq = require('tinyreq');
const cheerio = require('cheerio');

import { House, IHouseModel } from '../models/house';
import ConfigService from '../services/config.service';
import configService from '../services/config.service';
import { Config, IConfigModel } from '../models/config';
import BridgeService from './bridgeAPI.service';

export class HousesService {
    async all(): Promise<IHouseModel[]> {
        L.info('fetch all houses');

        const docs = (await House.find().lean().exec()) as IHouseModel[];

        return docs;
    }

    async byId(auctionNumber: string): Promise<IHouseModel> {
        L.info(`fetch house with _id ${auctionNumber}`);

        const doc = (await House.findOne({ auctionNumber: auctionNumber })
            .lean()
            .exec()) as IHouseModel;

        if (!doc) throw new errors.HttpError(HttpStatus.NOT_FOUND);

        return doc;
    }

    async byAuctionID(auctionID: string): Promise<IHouseModel[]> {
        L.info(`fetch houses with auctionID ${auctionID}`);

        const houses = (await House.find({ auctionID: auctionID }).lean().exec()) as IHouseModel[];

        return houses;
    }

    async create(houseData: IHouseModel): Promise<IHouseModel> {
        L.info(`create house with data ${houseData}`);

        const house = new House(houseData);

        const doc = (await house.save()) as IHouseModel;

        return doc;
    }

    async patch(auctionNumber: string, houseData: IHouseModel): Promise<IHouseModel> {
        try {
            L.info(`update house with _id ${auctionNumber} with data ${houseData}`);
            delete houseData['createdAt'];
            const doc = (await House.findOneAndUpdate(
                { auctionNumber: auctionNumber },
                { $set: houseData },
                { new: true, upsert: true }
            )
                .lean()
                .exec()) as IHouseModel;

            return doc;
        } catch (error) {
            return error;
        }
    }

    async remove(auctionNumber: string): Promise<void> {
        L.info(`delete house with id ${auctionNumber}`);

        return await House.findOneAndRemove({ auctionNumber: auctionNumber }).lean().exec();
    }

    async downloadPdf(url: string, destinationPath: string): Promise<Buffer> {
        try {
            const downloadPdfFile = download(url);
            const savePdfFile = fs.createWriteStream(destinationPath);

            downloadPdfFile.pipe(savePdfFile);

            const getJsonHouses = await new Promise<Buffer>(function (resolve, reject) {
                savePdfFile.on('finish', () => {
                    resolve(fs.readFileSync(destinationPath));
                });
                downloadPdfFile.on('error', reject);
            });

            return getJsonHouses;
        } catch (error) {
            console.log(error);
            return error;
        }
    }

    async parsePdfToJson(pdfPath: string, jsonPath: string): Promise<Buffer> {
        let blInputStream = fs.createReadStream(pdfPath);
        let blOutputStream = fs.createWriteStream(jsonPath);

        blInputStream.pipe(new PDFParser()).pipe(JSONStream.stringify()).pipe(blOutputStream);

        const parseJsonHouses = new Promise<Buffer>(function (resolve, reject) {
            blOutputStream.on('finish', () => {
                resolve(fs.readFileSync(jsonPath));
            });
            blInputStream.on('error', reject);
        });

        return parseJsonHouses;
    }

    translateHousesJson(jsonPath: string, isPP: boolean = false): IHouseModel[] {
        let retVal: IHouseModel[] = [];

        try {
            const docketRegex = /([A-Z])\w+-\d{2}-\d{6}/g; //Docket# regex - the anchor where our listing starts
            const addressRegex =
                /\b(p\.?\s?o\.?\b|post office|\d{1,5}|\s)\s*(?:\S\s*){8,50}(AK|Alaska|AL|Alabama|AR|Arkansas|AZ|Arizona|CA|California|CO|Colorado|CT|Connecticut|DC|Washington\sDC|Washington\D\.C\.|DE|Delaware|FL|Florida|GA|Georgia|GU|Guam|HI|Hawaii|IA|Iowa|ID|Idaho|IL|Illinois|IN|Indiana|KS|Kansas|KY|Kentucky|LA|Louisiana|MA|Massachusetts|MD|Maryland|ME|Maine|MI|Michigan|MN|Minnesota|MO|Missouri|MS|Mississippi|MT|Montana|NC|North\sCarolina|ND|North\sDakota|NE|New\sEngland|NH|New\sHampshire|NJ|New\sJersey|NM|New\sMexico|NV|Nevada|NY|New\sYork|OH|Ohio|OK|Oklahoma|OR|Oregon|PA|Pennsylvania|RI|Rhode\sIsland|SC|South\sCarolina|SD|South\sDakota|TN|Tennessee|TX|Texas|UT|Utah|VA|Virginia|VI|Virgin\sIslands|VT|Vermont|WA|Washington|WI|Wisconsin|WV|West\sVirginia|WY|Wyoming)(\s+|\&nbsp\;|\<(\S|\s){1,10}\>){1,5}\d{5}/i; //Address regex - the anchor where our listing ends
            const freeAndClearRegex = /F&C|F\s&\sC|FC|FREE\sAND\sCLEAR|FREE\s&\sCLEAR/gi;
            const bankRegex = /U\.?S\.?\sBANK|WELLS\sFARGO|DITECH\sFINANCIAL/gi;
            const dateRegex =
                /(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})\s+(\d{4})/gi;
            const taxLienRegex = /LIEN/gi;
            const housesRawData = fs.readFileSync(jsonPath);
            const housesPdf = JSON.parse(housesRawData.toString());
            let isInListingRange = false;
            let listing = [];
            const pages = housesPdf[0].formImage.Pages || [];
            let auctionID: string;
            let skipHeader = false;

            for (let page of pages) {
                let index = skipHeader ? 15 : 0;
                skipHeader = false;
                let last = page.Texts.length;
                let checksCounter = 0;

                while (index < last) {
                    try {
                        let addToListing = false;
                        let currentData = page.Texts[index].R[0].T;
                        if (
                            page.Texts[index] !== undefined &&
                            page.Texts[index].hasOwnProperty('y') &&
                            page.Texts[index].y !== 35.691 &&
                            page.Texts[index].y !== 1.5219999999999998
                        ) {
                            // If text is in valid range of page
                            if (currentData.match(docketRegex)) {
                                // Current text is the docket# this is where the listing starts
                                listing = [];
                                isInListingRange = true;
                            }
                            if (
                                !auctionID &&
                                (unescape(currentData).includes('Master Bid List') ||
                                    unescape(currentData).includes('Postponement List Sale'))
                            ) {
                                const isMatch = unescape(currentData)
                                    .replace(',', '')
                                    .match(dateRegex);
                                if (isMatch) {
                                    auctionID =
                                        (moment(new Date(isMatch[0])).month() + 1)
                                            .toString()
                                            .padStart(2, '0') +
                                        moment(new Date(isMatch[0])).year().toString();
                                }
                            }

                            if (currentData.indexOf('Report%20Date%3A%') !== -1) {
                                skipHeader = true;
                                break;
                            }

                            if (isInListingRange) {
                                addToListing = true;

                                if (page.Texts[index].x >= 51 && page.Texts[index].x <= 52) {
                                    // Current text is the Reason For PP text which follows with the checks
                                    //TODO: If we don't have a reason for PP we'll get a house with unordered details
                                    listing.push(unescape(currentData)); // Adding Reason for PP

                                    if (page.Texts[index + 1].R[0].T === 'Y') {
                                        listing.push(unescape(page.Texts[index + 1].R[0].T));
                                        checksCounter++;
                                    } else {
                                        listing.push('X');
                                    }

                                    if (page.Texts[index + 2].R[0].T === 'Y') {
                                        listing.push(unescape(page.Texts[index + 2].R[0].T));
                                        checksCounter++;
                                    } else {
                                        listing.push('X');
                                    }

                                    if (page.Texts[index + 3].R[0].T === 'Y') {
                                        listing.push(unescape(page.Texts[index + 3].R[0].T));
                                        checksCounter++;
                                    } else {
                                        listing.push('X');
                                    }

                                    addToListing = false;
                                }

                                if (index > 0 && page.Texts[index].x === page.Texts[index - 1].x) {
                                    // Multi-lines scenario
                                    listing[listing.length - 1] += unescape(currentData);
                                    addToListing = false;
                                }

                                if (unescape(currentData).match(addressRegex)) {
                                    //First address was found

                                    let addindex = index;
                                    let addresses = [];
                                    let isFreeAndClear = false;

                                    while (
                                        page.Texts[addindex] &&
                                        !unescape(page.Texts[addindex].R[0].T).match(docketRegex)
                                    ) {
                                        //Search for multiple addresses
                                        if (
                                            unescape(page.Texts[addindex].R[0].T).match(
                                                addressRegex
                                            )
                                        ) {
                                            addresses.push(unescape(page.Texts[addindex].R[0].T));
                                        }
                                        if (
                                            unescape(page.Texts[addindex].R[0].T).match(
                                                freeAndClearRegex
                                            )
                                        ) {
                                            isFreeAndClear = true;
                                        }

                                        addindex++;
                                    }

                                    let parsedHouse: any = {};
                                    parsedHouse.checks = {};
                                    listing.push(addresses);
                                    if (listing.length >= 17) {
                                        parsedHouse.isPP = isPP;
                                        if (!listing[13]) {
                                            continue; //TODO: Need to debug why we get listings with no auctionNumber (very few)
                                        }
                                        parsedHouse.auctionNumber = listing[13];
                                        parsedHouse.docketNumber = listing[0];
                                        parsedHouse.auctionID = auctionID;
                                        parsedHouse.attorneyName = listing[1];
                                        parsedHouse.plaintiffName = listing[2];
                                        parsedHouse.defendantName = listing[14];
                                        parsedHouse.saleType =
                                            listing &&
                                            listing[3] &&
                                            typeof listing[3] === 'string' &&
                                            listing[3].match(taxLienRegex)
                                                ? 'T'
                                                : 'M';
                                        const saleDate = new Date(listing[4]);
                                        parsedHouse.saleDate =
                                            saleDate && saleDate.toString() !== 'Invalid Date'
                                                ? saleDate
                                                : undefined;
                                        parsedHouse.saleStatus = listing[7];
                                        const ppDate = new Date(listing[8]);
                                        parsedHouse.ppDate =
                                            ppDate && ppDate.toString() !== 'Invalid Date'
                                                ? ppDate
                                                : undefined;
                                        parsedHouse.costTax =
                                            listing[5] && typeof listing[5] === 'string'
                                                ? parseFloat(
                                                      listing[5]
                                                          .replace(new RegExp(' ', 'g'), '')
                                                          .replace(new RegExp(',', 'g'), '')
                                                  )
                                                : -1;
                                        parsedHouse.costTax = !isNaN(parsedHouse.costTax)
                                            ? parsedHouse.costTax
                                            : undefined;
                                        parsedHouse.cost = listing[6]
                                            ? parseFloat(
                                                  listing[6]
                                                      .replace(new RegExp(' ', 'g'), '')
                                                      .replace(new RegExp(',', 'g'), '')
                                              )
                                            : -1;
                                        parsedHouse.cost = !isNaN(parsedHouse.cost)
                                            ? parsedHouse.cost
                                            : undefined;
                                        parsedHouse.reasonForPP = listing[9];
                                        parsedHouse.checks.svs = listing[10] && listing[10] === 'Y';
                                        parsedHouse.checks[3129] =
                                            listing[11] && listing[11] === 'Y';
                                        parsedHouse.checks.ok = listing[12] && listing[12] === 'Y';
                                        parsedHouse.municipality =
                                            listing[15] && typeof listing[15] === 'string'
                                                ? listing[15].replace('Municipality: ', '')
                                                : '';
                                        parsedHouse.address =
                                            listing[16] && _.isArray(listing[16])
                                                ? listing[16].map((addrss) => {
                                                      return addrss.replace(
                                                          new RegExp(',', 'g'),
                                                          ''
                                                      );
                                                  })
                                                : [];
                                        parsedHouse.isDuplicate = addresses.length > 1;
                                        parsedHouse.isFC = isFreeAndClear;
                                        parsedHouse.isBank =
                                            parsedHouse.plaintiffName &&
                                            typeof parsedHouse.plaintiffName === 'string'
                                                ? parsedHouse.plaintiffName.match(bankRegex)
                                                    ? true
                                                    : false
                                                : false;
                                    } else {
                                        parsedHouse.isPP = isPP;
                                        if (!listing[listing.length - 4]) {
                                            continue;
                                        }
                                        parsedHouse.auctionNumber = listing[listing.length - 4];
                                        parsedHouse.docketNumber = listing[0];
                                        parsedHouse.attorneyName = listing[1];
                                        parsedHouse.auctionID = auctionID;
                                        parsedHouse.plaintiffName = listing[2];
                                        parsedHouse.defendantName = listing[listing.length - 3];
                                        parsedHouse.saleType =
                                            listing &&
                                            listing[3] &&
                                            typeof listing[3] === 'string' &&
                                            listing[3].match(taxLienRegex)
                                                ? 'T'
                                                : 'M';
                                        const saleDate = new Date(listing[4]);
                                        parsedHouse.saleDate =
                                            saleDate && saleDate.toString() !== 'Invalid Date'
                                                ? saleDate
                                                : undefined;
                                        parsedHouse.saleStatus = listing[7];
                                        const ppDate = new Date(listing[8]);
                                        parsedHouse.ppDate =
                                            ppDate && ppDate.toString() !== 'Invalid Date'
                                                ? ppDate
                                                : undefined;
                                        parsedHouse.costTax =
                                            listing[5] && typeof listing[5] === 'string'
                                                ? parseFloat(
                                                      listing[5]
                                                          .replace(new RegExp(' ', 'g'), '')
                                                          .replace(new RegExp(',', 'g'), '')
                                                  )
                                                : -1;
                                        parsedHouse.costTax = !isNaN(parsedHouse.costTax)
                                            ? parsedHouse.costTax
                                            : undefined;
                                        parsedHouse.cost = listing[6]
                                            ? parseFloat(
                                                  listing[6]
                                                      .replace(new RegExp(' ', 'g'), '')
                                                      .replace(new RegExp(',', 'g'), '')
                                              )
                                            : -1;
                                        parsedHouse.cost = !isNaN(parsedHouse.cost)
                                            ? parsedHouse.cost
                                            : undefined;
                                        parsedHouse.reasonForPP =
                                            listing.length > 9 ? listing[9] : '';
                                        parsedHouse.checks.svs = false;
                                        parsedHouse.checks[3129] = false;
                                        parsedHouse.checks.ok = false;
                                        parsedHouse.municipality =
                                            listing &&
                                            listing.length &&
                                            listing.length > listing.length - 2 &&
                                            listing[listing.length - 2] &&
                                            typeof listing[listing.length - 2] === 'string'
                                                ? listing[listing.length - 2].replace(
                                                      'Municipality: ',
                                                      ''
                                                  )
                                                : '';
                                        parsedHouse.address =
                                            listing &&
                                            listing.length &&
                                            listing[listing.length - 1] &&
                                            _.isArray(listing[listing.length - 1])
                                                ? listing[listing.length - 1].map((addrss) => {
                                                      return addrss.replace(
                                                          new RegExp(',', 'g'),
                                                          ''
                                                      );
                                                  })
                                                : [];
                                        parsedHouse.isDuplicate = addresses.length > 1;
                                        parsedHouse.isFC = isFreeAndClear;
                                        parsedHouse.isBank =
                                            parsedHouse.plaintiffName &&
                                            typeof parsedHouse.plaintiffName === 'string'
                                                ? parsedHouse.plaintiffName.match(bankRegex)
                                                    ? true
                                                    : false
                                                : false;
                                    }
                                    retVal.push(parsedHouse);

                                    listing = [];
                                    addToListing = false;
                                }
                            }
                        }

                        if (addToListing) {
                            listing.push(unescape(currentData));
                        }
                        if (checksCounter > 0) {
                            index += checksCounter + 1;
                            checksCounter = 0;
                        } else {
                            index++;
                        }
                    } catch (ex) {
                        console.log('Missing house: ');
                        console.log(listing);
                        console.log(ex);
                        index++;
                    }
                }
            }

            return retVal;
        } catch (error) {
            console.log(error);
            return retVal;
        }
    }

    async updateJudgments(): Promise<void> {
        const JUDGMENTS_URL = 'http://www.pittsburghlegaljournal.org/subscribe/pn_sheriffsale.php';

        const updatedHouses = await tinyReq(JUDGMENTS_URL)
            .then(async (body) => {
                const judgments: any = {};
                const $ = cheerio.load(body); // Parse the HTML
                const dockets = $('span#notice_case_number');
                const judgmentSums = $('#notice_appraised_amount');
                let index = 0;

                dockets.each(function (key, docket) {
                    try {
                        if (docket.firstChild.data.length < 10) {
                            judgments[docket.prev.data + docket.firstChild.data] =
                                judgmentSums[index].children[0].data;
                        } else {
                            judgments[docket.firstChild.data] =
                                judgmentSums[index].children[0].data;
                        }
                        index++;
                    } catch (error) {
                        console.log(error.message);
                        index++;
                    }
                });

                const docketNumbers = Object.keys(judgments);
                let houses = (await House.find({
                    docketNumber: { $in: docketNumbers }
                })
                    .lean()
                    .exec()) as IHouseModel[];
                const housesUpdateRequests: Promise<IHouseModel>[] = [];
                houses.map((house) => {
                    house.judgment = parseFloat(
                        judgments[house.docketNumber]
                            .replace(new RegExp(' ', 'g'), '')
                            .replace(new RegExp(',', 'g'), '')
                    );
                });

                console.log(`Updating ${houses.length} houses with judgments data...`);
                await this.updateHouses(houses);
                return;

                //TODO: There was an idea to get all houses who we didn't find judgment on te website and look for it in the archieve
                // let workbook = new exceljs.Workbook();
                // workbook.xlsx.readFile('./backup/houses_db.xlsx').then(function () {
                //     let worksheet = workbook.getWorksheet(1);
                //     worksheet.spliceRows(0, 1);
                //     worksheet.eachRow(function (row, rowNumber) {
                //         try {
                //             judgments[row.getCell(13).value] = row.getCell(5).value;
                //         } catch (error) {

                //         }
                //     });

                // });
            })
            .catch((error) => {
                console.log(
                    `(${moment(Date.now()).format(
                        'DD/MM/YYYY HH:mm:ss'
                    )}) Failed to get Judgments: ${error.message}`
                );
                return;
            });

        return;
    }

    async getHouses(): Promise<IHouseModel[]> {
        const BIDLIST_PDF_URL = 'http://www.sheriffalleghenycounty.com/pdfs/bid_list/bid_list.pdf';
        const POSTPONEMENTS_PDF_URL =
            'http://www.sheriffalleghenycounty.com/pdfs/bid_list/postpone.pdf';
        const BIDLIST_FILE_PATH = 'houses/blHousing.pdf';
        const POSTPENMENTS_FILE_PATH = 'houses/psHousing.pdf';
        const BIDLIST_JSON_FILE_PATH = './pdf2json/blHousing.json';
        const POSTPENMENTS_JSON_FILE_PATH = './pdf2json/psHousing.json';

        try {
            // Download PDF files
            console.log('Retrieve Houses PDF from web site');
            await this.downloadPdf(BIDLIST_PDF_URL, BIDLIST_FILE_PATH);
            await this.downloadPdf(POSTPONEMENTS_PDF_URL, POSTPENMENTS_FILE_PATH); //For some unknown reason the download of this file might take too long, it looks like an issue with the Sheriff website if it's stuck just wait 10 minutes and try again

            // Parse PDF to JSON
            console.log('Parse PDF to JSON objects');
            await this.parsePdfToJson(BIDLIST_FILE_PATH, BIDLIST_JSON_FILE_PATH);
            await this.parsePdfToJson(POSTPENMENTS_FILE_PATH, POSTPENMENTS_JSON_FILE_PATH);

            // Translate JSON to Houses
            console.log('Parse houses from listings');
            let blHouses = this.translateHousesJson(BIDLIST_JSON_FILE_PATH);
            let ppHouses = this.translateHousesJson(POSTPENMENTS_JSON_FILE_PATH, true);

            // Save houses in DB
            console.log('Saving houses to DB');
            let houses = [...blHouses, ...ppHouses];
            const updateHousesResult = await this.updateHouses(houses);

            // Update houses with Judgments & Law Firms data
            console.log('Update houses with judgments & Law Firms data');
            await this.updateJudgments();
            await this.getLawFirmsJson(updateHousesResult.auctionID);

            // Update houses with Zillow data
            console.log('Update houses with Zillow data');
            await this.zillowUpdateHouses(updateHousesResult.auctionID);

            // Updating Invalid houses via Google Gecoding
            console.log('Update Invalid houses via Google Gecoding');
            const auctionID = await this.getCurrentAuctionID();
            if (!auctionID) {
                throw new Error('Unable to find current auctionID!');
            }
            await this.invalidHousesGeolcation(auctionID);

            // Parse houses to KML file
            console.log('Create KML file with houses');
            const globalPPDate = await ConfigService.updateGlobalPPDate(auctionID);
            await this.parseToKml(auctionID, globalPPDate);

            houses = await this.byAuctionID(updateHousesResult.auctionID);
            return houses;
        } catch (error) {
            console.log(error);
            return [];
        }
    }

    async updateHouses(housesData: IHouseModel[]): Promise<UpdateHousesResult> {
        L.info(`update houses`);
        let auctionID: string;

        try {
            const updateHousesPromise: Promise<IHouseModel>[] = [];

            //Find the auctionID
            for (let house of housesData) {
                if (!auctionID && house.auctionID) {
                    auctionID = house.auctionID;
                    break;
                }
            }

            for (let house of housesData) {
                updateHousesPromise.push(this.patch(house.auctionNumber, house));
            }

            await configService.setCurrentAuctionID(auctionID);
            const updatedHouses = await Promise.all(updateHousesPromise)
                .then((newHouses: IHouseModel[]) => {
                    console.log(`Updated ${updateHousesPromise.length} houses!`);
                    return new UpdateHousesResult(auctionID, newHouses);
                })
                .catch((error) => {
                    L.error(error.message, error);
                    console.log('Failed to update houses!');
                    return new UpdateHousesResult(auctionID);
                });

            return updatedHouses;
        } catch (error) {
            console.log(error);
            return new UpdateHousesResult(auctionID);
        }
    }

    async zillowUpdateHouses(auctionID: string): Promise<IHouseModel[]> {
        try {
            const houses = await this.byAuctionID(auctionID);
            let housesSentToZillow: IHouseModel[] = [];
            let zillowUpdateHousesPromise: Array<Promise<any>> = [];

            for (let house of houses) {
                try {
                    if (!house.address || !_.isArray(house.address) || house.address.length < 1) {
                        throw new Error('Invalid address for house!');
                    }
                    house.address[0] = house.address[0].replace('undefined', '');
                    house.address[0] = house.address[0].replace('&', '');
                    house.address[0] = house.address[0].replace('VACANT LAND', '');
                    house.address[0] = house.address[0].replace('AVENEUE', 'Ave');
                    const zipCode = house.address[0].match(/\b\d{5}\b/g)[0] || '';
                    house.address[0] = house.address[0].replace(zipCode, '');
                    if (
                        ((!house.zillowInvalid ||
                            (house.coords && house.coords.latitude && house.coords.longitude)) &&
                            (!house.zillowData || !house.zillowData.lastZillowUpdate)) ||
                        !moment(house.zillowData.lastZillowUpdate).isSame(
                            moment().startOf('day'),
                            'd'
                        )
                    ) {
                        zillowUpdateHousesPromise.push(BridgeService.getHouseZillowData(house));
                        housesSentToZillow.push(house);
                    }
                } catch (error) {
                    console.log(error.message);
                    house.zillowInvalid = true;
                    this.patch(house.auctionNumber, house);
                    continue;
                }
            }

            let houseIndex = 0;
            if (zillowUpdateHousesPromise.length === 0) {
                return [];
            }

            const zillowResults = await Promise.all(zillowUpdateHousesPromise);
            if (!zillowResults) {
                console.log('Failed to query zillow API');
                return [];
            }
            const houseUpdateRequests: Promise<IHouseModel>[] = [];
            for (let zillowResult of zillowResults) {
                try {
                    const zestimateResponse = zillowResult[0]?.data?.bundle[0];
                    const parcelResponse = zillowResult[1]?.data?.bundle[0];
                    const transactionResponse = zillowResult[2]?.data?.bundle[0];
                    if (
                        _.isEmpty(zestimateResponse) &&
                        _.isEmpty(parcelResponse) &&
                        _.isEmpty(transactionResponse)
                    ) {
                        if (!housesSentToZillow[houseIndex]?.zillowData?.zillowID) {
                            housesSentToZillow[houseIndex].zillowInvalid = true;
                            this.patch(
                                housesSentToZillow[houseIndex].auctionNumber,
                                housesSentToZillow[houseIndex]
                            );
                        }
                        houseIndex++;
                        continue;
                    }
                    const overloadedHouse: IHouseModel = this.updateHouseWithZillowData(
                        housesSentToZillow[houseIndex],
                        zestimateResponse,
                        parcelResponse,
                        transactionResponse
                    );
                    houseUpdateRequests.push(
                        this.patch(overloadedHouse.auctionNumber, overloadedHouse)
                    );
                    houseIndex++;
                } catch (error) {
                    if (!housesSentToZillow[houseIndex]?.zillowData?.zillowID) {
                        housesSentToZillow[houseIndex].zillowInvalid = true;
                        this.patch(
                            housesSentToZillow[houseIndex].auctionNumber,
                            housesSentToZillow[houseIndex]
                        );
                    }
                    houseIndex++;
                    continue;
                }
            }

            console.log(`Updating ${houseUpdateRequests.length} houses with Zillow data...`);
            const updateResult = await Promise.all(houseUpdateRequests);
            if (!updateResult) {
                console.log('Failed to update houses!');
                return [];
            }
            return houses;
        } catch (error) {
            console.log(error);
            return [];
        }
    }

    updateHouseWithZillowData(
        house: IHouseModel,
        zestimateResponse: any,
        parcelResponse: any,
        transactionResponse: any
    ): IHouseModel {
        const building =
            parcelResponse.building?.length && parcelResponse.building.length > 0
                ? parcelResponse.building[0]
                : undefined;
        if (!house.zillowData) {
            const zillowData: any = {};
            house.zillowData = zillowData;
        }
        house.zillowData.taxAssessment = transactionResponse?.totalTransferTax
            ? transactionResponse.totalTransferTax
            : undefined;
        house.zillowData.zillowEstimate = zestimateResponse?.zestimate
            ? zestimateResponse.zestimate
            : undefined;
        house.zillowData.zillowRentalEstimate =
            zestimateResponse?.rental?.length && zestimateResponse.rental?.length > 0
                ? zestimateResponse.rental[0].zestimate
                : undefined;
        house.zillowData.rooms = building?.bedrooms;
        house.zillowData.bath = building?.baths || building?.fullBaths || building?.halfBaths;
        house.zillowData.sqft = parcelResponse?.lotSizeSquareFeet
            ? parcelResponse.lotSizeSquareFeet
            : undefined;
        house.zillowData.yearBuilt = building?.yearBuilt;
        house.zillowData.zillowID = zestimateResponse?.zpid || parcelResponse?.zpid;
        house.zillowData.zillowLink = zestimateResponse?.zillowUrl
            ? zestimateResponse.zillowUrl
            : undefined;
        house.zillowData.lastSoldDate =
            transactionResponse?.signatureDate || transactionResponse?.recordingDate;
        house.zillowData.lastSoldPrice = transactionResponse?.salesPrice
            ? transactionResponse.salesPrice
            : undefined;
        house.zillowData.zillowAddress = parcelResponse?.address?.full;
        house.coords = {
            longitude: parcelResponse?.coordinates ? parcelResponse.coordinates[0] : undefined,
            latitude: parcelResponse?.coordinates ? parcelResponse.coordinates[1] : undefined
        };
        house.zillowData.apn = parcelResponse?.apn ? parcelResponse.apn : undefined;
        house.zillowData.unpaidBalance = transactionResponse?.unpaidBalance
            ? transactionResponse.unpaidBalance
            : undefined;
        house.zillowData.lenderName =
            transactionResponse?.lenderName?.length && transactionResponse.lenderName.length > 0
                ? transactionResponse.lenderName[0]
                : undefined;

        house.zillowInvalid = false;
        house.zillowData.lastZillowUpdate = new Date();

        return house;
    }

    async parseToKml(auctionID: string, globalPPDate: Date): Promise<void> {
        const date = new Date(`${auctionID.substring(0, 2)}/01/${auctionID.substring(2, 6)}`);
        let currentMonth = moment(date).format('MMMM');
        let kml: string[] = [];

        console.log(`auctionID: ${auctionID}`);
        console.log(`globalPPDate: ${globalPPDate}`);

        kml.push('<kml xmlns = "http://www.opengis.net/kml/2.2"><Document><name>');
        kml.push(currentMonth);
        kml.push('</name><open>1</open><description>');
        kml.push(`${currentMonth} postponements</description><name>Placemarks</name>`);
        kml.push('<Style id = "stayPlacemark"><IconStyle><Icon><href>');
        kml.push(
            'http://maps.google.com/mapfiles/ms/icons/grey.png',
            '</href></Icon></IconStyle></Style>'
        );
        kml.push('<Style id = "mortgageExpensivePlacemark"><IconStyle><Icon><href>');
        kml.push(
            'http://maps.google.com/mapfiles/ms/icons/red-dot.png',
            '</href></Icon></IconStyle></Style>'
        );
        kml.push('<Style id = "mortgagePlacemark"><IconStyle><Icon><href>');
        kml.push(
            'http://maps.google.com/mapfiles/ms/icons/red.png',
            '</href></Icon></IconStyle></Style>'
        );
        kml.push('<Style id = "taxLienExpensivePlacemark"><IconStyle><Icon><href>');
        kml.push(
            'http://maps.google.com/mapfiles/ms/icons/yellow-dot.png',
            '</href></Icon></IconStyle></Style>'
        );
        kml.push('<Style id = "taxLienPlacemark"><IconStyle><Icon><href>');
        kml.push(
            'http://maps.google.com/mapfiles/ms/icons/yellow.png',
            '</href></Icon></IconStyle></Style>'
        );
        kml.push('<Style id = "freeAndClearExpensivePlacemark"><IconStyle><Icon><href>');
        kml.push(
            'http://maps.google.com/mapfiles/ms/icons/blue-dot.png',
            '</href></Icon></IconStyle></Style>'
        );
        kml.push('<Style id = "freeAndClearPlacemark"><IconStyle><Icon><href>');
        kml.push(
            'http://maps.google.com/mapfiles/ms/icons/blue.png',
            '</href></Icon></IconStyle></Style>'
        );
        kml.push('<Style id = "bankExpensivePlacemark"><IconStyle><Icon><href>');
        kml.push(
            'http://maps.google.com/mapfiles/ms/icons/green-dot.png',
            '</href></Icon></IconStyle></Style>'
        );
        kml.push('<Style id = "bankPlacemark"><IconStyle><Icon><href>');
        kml.push(
            'http://maps.google.com/mapfiles/ms/icons/green.png',
            '</href></Icon></IconStyle></Style>'
        );
        kml.push('<Style id = "zillowInvalid"><IconStyle><Icon><href>');
        kml.push(
            'http://maps.google.com/mapfiles/ms/icons/orange.png',
            '</href></Icon></IconStyle></Style>'
        );
        kml.push(
            '<LookAt><longitude>-79.997</longitude><latitude>40.445</latitude><altitude>0</altitude>'
        );
        kml.push(
            '<heading>-148.4122922628044</heading><tilt>0</tilt><range>500000</range></LookAt>'
        );

        const houses = (await House.find({
            auctionID: auctionID,
            coords: { $exists: true }
        })
            .lean()
            .exec()) as IHouseModel[];

        for (let house of houses) {
            if (house?.coords?.longitude !== '0' && house?.coords?.latitude !== '0') {
                kml.push(this.buildKmlString(house, globalPPDate));
            }
        }

        kml.push('</Document></kml>');
        const retVal = kml.join('');

        try {
            await writeFile('./kml/map.kml', retVal);
            console.log('KML file was saved successfully!');
        } catch (error) {
            console.log(error);
        }
    }

    buildKmlString(house: IHouseModel, globalPPDate: Date): string {
        let stream = [];
        let markerType = this.analyzeMarkerType(house, globalPPDate);

        if (!house) {
            return '';
        }

        try {
            stream.push('<Placemark>');
            stream.push(
                '<name>',
                house.zillowData
                    ? house.zillowData.zillowAddress
                    : house.address && house.address.length && house.address.length > 0
                    ? house.address[0]
                    : '',
                '</name>'
            );
            stream.push('<styleUrl>', markerType, '</styleUrl>');
            stream.push('<ExtendedData>');
            stream.push(
                '<Data name="Auction Number"><value>',
                house.auctionNumber,
                '</value></Data>'
            );
            stream.push('<Data name="Sale Type"><value>', house.saleType, '</value></Data>');
            stream.push(
                '<Data name="Judgment"><value>',
                house.judgment
                    ? new Intl.NumberFormat('en-US', {
                          style: 'currency',
                          currency: 'USD'
                      }).format(house.judgment)
                    : '',
                '</value></Data>'
            );
            stream.push(
                '<Data name="Tax Estimate"><value>',
                house.zillowData && house.zillowData.taxAssessment
                    ? new Intl.NumberFormat('en-US', {
                          style: 'currency',
                          currency: 'USD'
                      }).format(house.zillowData.taxAssessment)
                    : '',
                '</value></Data>'
            );
            stream.push(
                '<Data name="Zillow Estimate"><value>',
                house.zillowData && house.zillowData.zillowEstimate
                    ? new Intl.NumberFormat('en-US', {
                          style: 'currency',
                          currency: 'USD'
                      }).format(house.zillowData.zillowEstimate)
                    : '',
                '</value></Data>'
            );
            stream.push(
                '<Data name="Zillow Rental Estimate"><value>',
                house.zillowData?.zillowRentalEstimate >= 0
                    ? new Intl.NumberFormat('en-US', {
                          style: 'currency',
                          currency: 'USD'
                      }).format(house.zillowData.zillowRentalEstimate)
                    : '',
                '</value></Data>'
            );
            stream.push(
                '<Data name="Last Sold Price"><value>',
                house.zillowData && house.zillowData.lastSoldPrice
                    ? new Intl.NumberFormat('en-US', {
                          style: 'currency',
                          currency: 'USD'
                      }).format(house.zillowData.lastSoldPrice)
                    : '',
                '</value></Data>'
            );
            stream.push(
                '<Data name="Last Sold Date"><value>',
                house.zillowData && house.zillowData.lastSoldDate
                    ? moment(house.zillowData.lastSoldDate).format('ll')
                    : '',
                '</value></Data>'
            );
            stream.push(
                '<Data name="Sqft"><value>',
                house.zillowData && house.zillowData.sqft
                    ? new Intl.NumberFormat('en-US').format(house.zillowData.sqft)
                    : '',
                '</value></Data>'
            );
            stream.push(
                '<Data name="Rooms"><value>',
                house.zillowData ? house.zillowData.rooms : '',
                '</value></Data>'
            );
            stream.push(
                '<Data name="Baths"><value>',
                house.zillowData ? house.zillowData.bath : '',
                '</value></Data>'
            );
            stream.push(
                '<Data name="Year Built"><value>',
                house.zillowData ? house.zillowData.yearBuilt : '',
                '</value></Data>'
            );
            stream.push(
                '<Data name="APN"><value>',
                house.zillowData?.apn ? house.zillowData.apn : '',
                '</value></Data>'
            );
            stream.push(
                '<Data name="Unpaid Balance"><value>',
                house.zillowData?.unpaidBalance >= 0
                    ? new Intl.NumberFormat('en-US', {
                          style: 'currency',
                          currency: 'USD'
                      }).format(house.zillowData.unpaidBalance)
                    : '',
                '</value></Data>'
            );
            stream.push(
                '<Data name="Lender Name"><value>',
                house.zillowData?.lenderName ? house.zillowData.lenderName : '',
                '</value></Data>'
            );
            stream.push(
                '<Data name="Attorney Name"><value>',
                house.attorneyName,
                '</value></Data>'
            );
            if (house.firmName) {
                stream.push('<Data name="Firm Name"><value>', house.firmName, '</value></Data>');
            }
            if (house.contactEmail) {
                stream.push(
                    '<Data name="Contact Email"><value>',
                    house.contactEmail,
                    '</value></Data>'
                );
            }
            stream.push(
                '<Data name="Plaintiff Name"><value>',
                house.plaintiffName.replace(new RegExp('&', 'g'), 'and'),
                '</value></Data>'
            );
            stream.push(
                '<Data name="Cost Tax"><value>',
                house.costTax && house.costTax >= 0
                    ? new Intl.NumberFormat('en-US', {
                          style: 'currency',
                          currency: 'USD'
                      }).format(house.costTax)
                    : '',
                '</value></Data>'
            );
            stream.push(
                '<Data name="Checks"><value>',
                house.checks
                    ? `${house.checks.svs ? 'Y' : 'X'} ${house.checks['3129'] ? 'Y' : 'X'} ${
                          house.checks.ok ? 'Y' : 'X'
                      }`
                    : '',
                '</value></Data>'
            );
            stream.push(
                '<Data name="Docket Number"><value>',
                house.docketNumber,
                '</value></Data>'
            );
            stream.push(
                '<Data name="Zillow Link"><value>',
                house.zillowData ? house.zillowData.zillowLink : '',
                '</value></Data>'
            );
            stream.push('<Data name="Duplicate"><value>', house.isDuplicate, '</value></Data>');
            if (house.ppDate) {
                stream.push(
                    '<Data name="PP Date"><value>',
                    house.ppDate ? moment(house.ppDate).format('ll') : '',
                    '</value></Data>'
                );
            }
            stream.push('</ExtendedData>');
            stream.push('<Point>');
            stream.push(
                '<coordinates>',
                house.coords && house.coords.longitude ? house.coords.longitude : '',
                ',',
                house.coords && house.coords.latitude ? house.coords.latitude : '',
                ',0</coordinates>'
            );
            stream.push('</Point></Placemark>');

            return stream.join('').replace(/[&]/g, '');
        } catch (ex) {
            return '';
        }
    }

    analyzeMarkerType(house: IHouseModel, globalPPDate: Date): string {
        try {
            if (house.zillowInvalid) {
                return '#zillowInvalid';
            }
            if (house.saleStatus && house.saleStatus === 'STAYED') {
                return '#stayPlacemark';
            }
            if (
                house.ppDate &&
                globalPPDate &&
                moment(house.ppDate).isAfter(moment(globalPPDate))
            ) {
                return '#stayPlacemark';
            }

            if (house.isFC) {
                if (
                    house.zillowData &&
                    house.zillowData.zillowEstimate &&
                    !isNaN(house.zillowData.zillowEstimate) &&
                    house.zillowData.zillowEstimate > 85000
                ) {
                    return '#freeAndClearExpensivePlacemark';
                }

                return '#freeAndClearPlacemark';
            }

            if (house.isBank) {
                if (
                    house.zillowData &&
                    house.zillowData.zillowEstimate &&
                    !isNaN(house.zillowData.zillowEstimate) &&
                    house.zillowData.zillowEstimate > 85000
                ) {
                    return '#bankExpensivePlacemark';
                }

                return '#bankPlacemark';
            }

            if (house.saleType && house.saleType === 'T') {
                if (
                    house.zillowData &&
                    house.zillowData.zillowEstimate &&
                    !isNaN(house.zillowData.zillowEstimate) &&
                    house.zillowData.zillowEstimate > 85000
                ) {
                    return '#taxLienExpensivePlacemark';
                }

                return '#taxLienPlacemark';
            }

            if (house.saleType && house.saleType === 'M') {
                if (
                    house.zillowData &&
                    house.zillowData.zillowEstimate &&
                    !isNaN(house.zillowData.zillowEstimate) &&
                    house.zillowData.zillowEstimate > 85000
                ) {
                    return '#mortgageExpensivePlacemark';
                }

                return '#mortgagePlacemark';
            }
        } catch (ex) {
            console.log(ex.stack);
            return '#mortgagePlacemark';
        }
    }

    async getValidZillowApiToken(houses: IHouseModel[]): Promise<string> {
        const zillowTokens: string[] = [
            process.env.ZILLOW_TOKEN_1,
            process.env.ZILLOW_TOKEN_2,
            process.env.ZILLOW_TOKEN_3,
            process.env.ZILLOW_TOKEN_4
        ];
        let address: string;
        let zipCode: string;
        let validationAttempts = 0;

        try {
            for (let house of houses) {
                const zillowRequests = [];
                if (house.address && _.isArray(house.address) && house.address.length > 0) {
                    address = house.address[0].replace('undefined', '');
                    zipCode = house.address[0].match(/\b\d{5}\b/g)[0] || '';
                    if (!address && !zipCode) {
                        continue;
                    }
                    const params = {
                        citystatezip: zipCode,
                        address: address.replace(zipCode, '')
                    };
                    for (let token of zillowTokens) {
                        zillowRequests.push(new Zillow(token).get('GetDeepSearchResults', params));
                    }

                    const retVal = await Promise.all(zillowRequests)
                        .then((results) => {
                            let index = 0;
                            validationAttempts++;
                            console.log(
                                `Attempt #${validationAttempts} to get valid Zillow api token`
                            );
                            for (let result of results) {
                                if (result.message.code == 0) {
                                    return zillowTokens[index];
                                }
                                index++;
                            }
                            return '';
                        })
                        .catch((error) => {
                            console.log(error);
                            validationAttempts++;
                            console.log(
                                `Attempt #${validationAttempts + 1} to get valid Zillow api token`
                            );
                            return '';
                        });
                    if (!retVal) {
                        continue;
                    } else {
                        return retVal || '';
                    }
                }
            }

            return '';
        } catch (error) {
            console.log(error);
            return '';
        }
    }

    async getLawFirmsJson(auctionID: string): Promise<void> {
        const LAW_FIRMS_EXCEL = 'lawFirms/lawFirms.xlsx';

        try {
            const houses = await this.byAuctionID(auctionID);

            let lawFirms = await excelToJson({
                sourceFile: LAW_FIRMS_EXCEL,
                header: {
                    rows: 1
                },
                columnToKey: {
                    A: 'nameOnFile',
                    B: 'firmDetails',
                    C: 'firmRemarks',
                    D: 'comments'
                }
            });

            if (lawFirms && lawFirms.Sheet1) {
                lawFirms = lawFirms.Sheet1;
            } else {
                throw new Error('Failed to parse law firms excel to json!');
            }

            for (let house of houses) {
                const firm = lawFirms.find((firm) => house.attorneyName.includes(firm.nameOnFile));
                house.firmName = firm && firm.firmDetails ? firm.firmDetails : '';
                house.contactEmail = firm && firm.firmRemarks ? firm.firmRemarks : '';
            }

            console.log(`Updating ${houses.length} houses with law firms data...`);
            await this.updateHouses(houses);
            return;
        } catch (error) {
            console.log(error);
            return;
        }
    }

    async getCurrentAuctionID(): Promise<string> {
        const config = (await Config.findOne({ key: 'currentAuctionID' })
            .lean()
            .exec()) as IConfigModel;
        return config.value;
    }

    async invalidHousesGeolcation(auctionID): Promise<void> {
        try {
            const options = {
                provider: 'google',
                httpAdapter: 'https',
                apiKey: process.env.GOOGLE_GEOLOCATION_API_KEY,
                formatter: null
            };
            const geocoder = NodeGeocoder(options);
            const houses: IHouseModel[] = [];

            const invalidHouses = (await House.find({
                auctionID: auctionID,
                zillowInvalid: true,
                coords: { $exists: false },
                'address.0': { $exists: true, $ne: '' }
            })
                .lean()
                .exec()) as IHouseModel[];

            invalidHouses.map((house) => {
                houses.push(geocoder.geocode(house.address[0]));
            });

            Promise.all(houses)
                .then(async (geolocationResults) => {
                    if (!geolocationResults || geolocationResults.length === 0) return;
                    let updatedHouses: IHouseModel[];
                    geolocationResults.map((result) => {
                        updatedHouses = invalidHouses.map((house) => {
                            if (house.address[0].includes(result[0].zipcode)) {
                                house.coords = {
                                    latitude: result[0].latitude,
                                    longitude: result[0].longitude
                                };
                                house.address[0] = result[0].formattedAddress;
                            }
                            return house;
                        });
                    });
                    updatedHouses = updatedHouses.filter(
                        (house) => house.coords && house.coords.latitude && house.coords.longitude
                    );
                    await this.updateHouses(updatedHouses);
                })
                .catch((error) => {
                    console.log(error);
                });
        } catch (error) {
            console.log(error);
            return;
        }
    }

    async sendEmailNotification(): Promise<void> {}

    downloadKMLfile(): any {
        const filename = 'map.kml';
        const filePath = path.join(__dirname, '..', '..', '..', 'kml', filename);
        const stat = fs.statSync(filePath);
        const fileToSend = fs.readFileSync(filePath);
        return {
            filename,
            stat,
            fileToSend
        };
    }
}

class UpdateHousesResult {
    auctionID: string;
    count: number;
    houses: IHouseModel[];

    constructor(auctionID: string, houses?: IHouseModel[], count?: number) {
        this.auctionID = auctionID;
        this.houses = houses || [];
        this.count = houses.length;
    }
}

export default new HousesService();
