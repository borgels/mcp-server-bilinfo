import { describe, expect, it, vi } from 'vitest';
import type { UpstreamClient } from '../src/bilinfo/client.js';
import {
  danishToday,
  EXPORT_PATH,
  fetchVehicles,
  getVehicle,
  isoDate,
  listVehicles,
  stockOverview,
  toRow,
  UNEXPECTED_ANSWER,
  VEHICLE_NOT_FOUND,
} from '../src/bilinfo/vehicles.js';
import { carId, exportBody, FJORDBY, listingId, NORDKYST, sampleStock, TODAY, vehicle } from './helpers.js';

function clientAnswering(body: unknown, dealerId?: string) {
  const get = vi.fn(async () => body);
  return { client: { get, dealerId } as unknown as UpstreamClient, get };
}

const ids = (rows: Array<{ vehicleId?: string }>) => rows.map(row => row.vehicleId);

describe('reading the list from Bilinfo', () => {
  it('reads the one export request and returns the vehicles', async () => {
    const { client, get } = clientAnswering(exportBody(sampleStock()));
    const vehicles = await fetchVehicles(client);
    expect(vehicles).toHaveLength(5);
    expect(get).toHaveBeenCalledWith(EXPORT_PATH, undefined);
    expect(EXPORT_PATH).toBe('/api/export');
  });

  it('limits the request to the dealer of the instance', async () => {
    const { client, get } = clientAnswering(exportBody([]), FJORDBY.DealerGuid);
    await expect(fetchVehicles(client)).resolves.toEqual([]);
    expect(get).toHaveBeenCalledWith(EXPORT_PATH, { dealerId: FJORDBY.DealerGuid });
  });

  it('refuses any answer that is not the documented list, with our own text', async () => {
    for (const body of [null, [], 'Service unavailable', { Vehicles: 'none' }, { Vehicles: [1, 2] }, { vehicles: [] }, { Message: 'Denied' }]) {
      await expect(fetchVehicles(clientAnswering(body).client), JSON.stringify(body)).rejects.toThrow(UNEXPECTED_ANSWER);
    }
  });
});

describe('dates', () => {
  it('reads day-month-year with or without a time of day, and nothing else', () => {
    expect(isoDate('01-10-2026 12:30:00')).toBe('2026-10-01');
    expect(isoDate('14-03-2019')).toBe('2019-03-14');
    for (const value of ['31-02-2026', '2026-10-01', '1-10-2026', '', 'i går', undefined, 20261001]) {
      expect(isoDate(value), String(value)).toBeUndefined();
    }
  });

  it('counts today as the calendar day in Denmark', () => {
    expect(danishToday(new Date('2026-11-24T22:59:00Z'))).toBe('2026-11-24');
    expect(danishToday(new Date('2026-11-24T23:30:00Z'))).toBe('2026-11-25');
    // Summer time: two hours ahead of UTC.
    expect(danishToday(new Date('2026-06-30T22:30:00Z'))).toBe('2026-07-01');
  });
});

describe('a row for one listing', () => {
  it('turns the texts Bilinfo sends into numbers and an ISO date', () => {
    expect(toRow(vehicle(1), TODAY)).toEqual({
      vehicleId: listingId(1),
      make: 'Volkswagen',
      model: 'Golf',
      variant: '1,5 TSi 150 Style DSG',
      year: 2019,
      mileageKm: 55000,
      fuel: 'Benzin',
      gearType: 'A',
      type: 'Personvogn',
      price: 189900,
      priceType: 'RetailPrice',
      createdDate: '2026-10-01',
      daysSinceCreated: 55,
      pictureCount: 2,
    });
  });

  it('leaves out what Bilinfo did not send or sent in another form, and never guesses', () => {
    const row = toRow(vehicle(1, { Mileage: 'ukendt', Variant: '', CreatedDate: '', Year: '19', Price: '189.900' }), TODAY);
    expect(row.mileageKm).toBeUndefined();
    expect(row.variant).toBeUndefined();
    expect(row.createdDate).toBeUndefined();
    expect(row.daysSinceCreated).toBeUndefined();
    expect(row.price).toBeUndefined();
    expect(row.year).toBe(19);
    // "Call for price" has no price, whatever number Bilinfo sends with it.
    expect(toRow(vehicle(1, { PriceType: 'CallForPrice', Price: '0' }), TODAY).price).toBeUndefined();
    // A listing created later today (or with a date ahead of ours) counts as 0 days.
    expect(toRow(vehicle(1, { CreatedDate: '26-11-2026 01:00:00' }), TODAY).daysSinceCreated).toBe(0);
  });
});

describe('listing vehicles', () => {
  const all = sampleStock();
  const list = (input: Parameters<typeof listVehicles>[1] = {}) => listVehicles(all, input, TODAY);

  it('returns every listing in Bilinfo\'s order with paging figures', () => {
    const result = list();
    expect(result).toMatchObject({ matching: 5, total: 5, page: 1, pageSize: 25, pageCount: 1 });
    expect(ids(result.vehicles)).toEqual([1, 2, 3, 4, 5].map(listingId));
    // One dealer: the dealer is not repeated on every row.
    expect(result.vehicles.every(row => row.dealer === undefined)).toBe(true);
  });

  it('filters on make, model and fuel without regard to case', () => {
    expect(ids(list({ make: 'volks' }).vehicles)).toEqual([1, 5].map(listingId));
    expect(ids(list({ model: 'ENYAQ' }).vehicles)).toEqual([2, 3].map(listingId));
    expect(ids(list({ fuel: 'diesel' }).vehicles)).toEqual([4].map(listingId));
    // A hybrid is found under both of its fuels.
    expect(ids(list({ fuel: 'el' }).vehicles)).toEqual([2, 3, 5].map(listingId));
    expect(list({ make: 'Volkswagen', model: 'Enyaq' })).toMatchObject({ matching: 0, total: 5, pageCount: 0, vehicles: [] });
  });

  it('applies a price range to purchase prices only', () => {
    // The leasing listing (3.495 kr. a month) and the one without a price are left out, not matched by accident.
    expect(ids(list({ priceMax: 170_000 }).vehicles)).toEqual([4].map(listingId));
    expect(ids(list({ priceMin: 170_000 }).vehicles)).toEqual([1, 2].map(listingId));
    expect(ids(list({ priceMin: 189_900, priceMax: 189_900 }).vehicles)).toEqual([1].map(listingId));
    expect(ids(list({ priceMin: 0 }).vehicles)).toEqual([1, 2, 4].map(listingId));
  });

  it('filters on model year', () => {
    expect(ids(list({ yearMin: 2021 }).vehicles)).toEqual([2, 3, 5].map(listingId));
    expect(ids(list({ yearMax: 2019 }).vehicles)).toEqual([1].map(listingId));
    expect(ids(list({ yearMin: 2020, yearMax: 2021 }).vehicles)).toEqual([4, 5].map(listingId));
  });

  it('searches free text across description, equipment, colour and type, every word required', () => {
    expect(ids(list({ query: 'anhængertræk blå' }).vehicles)).toEqual([2].map(listingId));
    expect(ids(list({ query: 'VAREVOGN' }).vehicles)).toEqual([4].map(listingId));
    expect(ids(list({ query: 'varmepumpe' }).vehicles)).toEqual([2].map(listingId));
    expect(list({ query: 'golf diesel' }).matching).toBe(0);
  });

  it('sorts by time listed and by purchase price, with listings lacking the value last', () => {
    expect(ids(list({ sort: 'longest_listed' }).vehicles)).toEqual([4, 5, 1, 2, 3].map(listingId));
    expect(ids(list({ sort: 'newest_listed' }).vehicles)).toEqual([3, 2, 1, 5, 4].map(listingId));
    expect(ids(list({ sort: 'price_low' }).vehicles)).toEqual([4, 1, 2, 3, 5].map(listingId));
    expect(ids(list({ sort: 'price_high' }).vehicles)).toEqual([2, 1, 4, 3, 5].map(listingId));
  });

  it('pages the result', () => {
    const second = list({ pageSize: 2, page: 2 });
    expect(second).toMatchObject({ matching: 5, page: 2, pageSize: 2, pageCount: 3 });
    expect(ids(second.vehicles)).toEqual([3, 4].map(listingId));
    expect(ids(list({ pageSize: 2, page: 3 }).vehicles)).toEqual([5].map(listingId));
    expect(list({ pageSize: 2, page: 4 }).vehicles).toEqual([]);
  });

  it('names the dealer on each row when the account covers more than one', () => {
    const two = [vehicle(1), vehicle(2, NORDKYST)];
    expect(listVehicles(two, {}, TODAY).vehicles.map(row => row.dealer)).toEqual([FJORDBY.DealerName, NORDKYST.DealerName]);
    // Also when the filter leaves vehicles from one of them only.
    expect(listVehicles(two, { pageSize: 1 }, TODAY).vehicles[0]?.dealer).toBe(FJORDBY.DealerName);
  });
});

describe('one vehicle', () => {
  const all = sampleStock();

  it('returns the summary and every field Bilinfo sent, but for the two retired ones', () => {
    const details = getVehicle(all, listingId(1).toUpperCase(), TODAY);
    expect(details.summary).toMatchObject({ vehicleId: listingId(1), make: 'Volkswagen', price: 189900, daysSinceCreated: 55 });
    expect(details.fields).toMatchObject({
      VehicleId: listingId(1),
      RegistrationDate: '14-03-2019',
      Mileage: '55000',
      CashPrice: '189900',
      PictureCount: '2',
      DealerName: FJORDBY.DealerName,
      ExtraEquipmentList: [
        { Id: '11', Name: 'Fartpilot' },
        { Id: '12', Name: 'Klimaanlæg' },
      ],
    });
    expect((details.fields.Pictures as string[])[0]).toContain('?class=S1600X1600');
    expect(details.fields).not.toHaveProperty('Id');
    expect(details.fields).not.toHaveProperty('EquipmentList');
    expect(details.otherListingsOfSameCar).toBeUndefined();
  });

  it('names the other listings of the same car', () => {
    expect(getVehicle(all, listingId(2), TODAY).otherListingsOfSameCar).toEqual([
      { vehicleId: listingId(3), priceType: 'Leasing', price: 3495 },
    ]);
    expect(getVehicle(all, listingId(3), TODAY).otherListingsOfSameCar).toEqual([
      { vehicleId: listingId(2), priceType: 'RetailPrice', price: 299900 },
    ]);
  });

  it('says so in plain words when the listing is not there', () => {
    expect(() => getVehicle(all, listingId(99), TODAY)).toThrow(VEHICLE_NOT_FOUND);
    // The car's id is not the listing's id.
    expect(() => getVehicle(all, carId(1), TODAY)).toThrow(VEHICLE_NOT_FOUND);
  });
});

describe('stock overview', () => {
  it('counts listings and cars, adds up purchase prices per price type and groups by make and age', () => {
    expect(stockOverview(sampleStock(), TODAY)).toEqual({
      listings: 5,
      cars: 4,
      askingPrices: [
        { priceType: 'RetailPrice', listings: 2, total: 489_800, average: 244_900 },
        // A price per month is counted, never added to prices to buy.
        { priceType: 'Leasing', listings: 1 },
        { priceType: 'RetailPriceWithoutTax', listings: 1, total: 164_900, average: 164_900 },
        { priceType: 'CallForPrice', listings: 1 },
      ],
      byMake: [
        { make: 'Volkswagen', cars: 2 },
        { make: 'Ford', cars: 1 },
        { make: 'Skoda', cars: 1 },
      ],
      byDaysSinceCreated: {
        groups: [
          { group: '0-30 dage', cars: 1 },
          { group: '31-60 dage', cars: 1 },
          { group: '61-90 dage', cars: 0 },
          { group: '91-180 dage', cars: 1 },
          { group: 'over 180 dage', cars: 1 },
        ],
        averageDays: 98,
        longest: { vehicleId: listingId(4), make: 'Ford', model: 'Transit Custom', createdDate: '2026-04-15', daysSinceCreated: 224 },
        withoutDate: 0,
      },
    });
  });

  it('puts the edges of the age groups in the right group', () => {
    const created = (date: string, n: number) => vehicle(n, { CreatedDate: `${date} 08:00:00` });
    const overview = stockOverview(
      [created('25-11-2026', 1), created('26-10-2026', 2), created('25-10-2026', 3), created('26-08-2026', 4), created('29-05-2026', 5), created('28-05-2026', 6)],
      TODAY,
    );
    // 0, 30, 31, 91, 180 and 181 days.
    expect(overview.byDaysSinceCreated.groups.map(group => group.cars)).toEqual([2, 1, 0, 2, 1]);
  });

  it('leaves cars without a readable date out of the age groups and says how many', () => {
    const overview = stockOverview([vehicle(1, { CreatedDate: '' }), vehicle(2, { Make: '', Price: 'efter aftale' })], TODAY);
    expect(overview.byDaysSinceCreated).toMatchObject({ withoutDate: 1, averageDays: 55 });
    expect(overview.byMake).toEqual([
      { make: 'Ukendt mærke', cars: 1 },
      { make: 'Volkswagen', cars: 1 },
    ]);
    // A price that is not a number is not added: one of two listings is priced.
    expect(overview.askingPrices).toEqual([{ priceType: 'RetailPrice', listings: 2, total: 189_900, average: 189_900 }]);
  });

  it('answers an empty stock with zeros, not an error', () => {
    expect(stockOverview([], TODAY)).toEqual({
      listings: 0,
      cars: 0,
      askingPrices: [],
      byMake: [],
      byDaysSinceCreated: {
        groups: ['0-30 dage', '31-60 dage', '61-90 dage', '91-180 dage', 'over 180 dage'].map(group => ({ group, cars: 0 })),
        withoutDate: 0,
      },
    });
  });

  it('splits the cars by dealer when the account covers more than one', () => {
    const overview = stockOverview([vehicle(1), vehicle(2, NORDKYST), vehicle(3, NORDKYST)], TODAY);
    expect(overview.dealers).toEqual([
      { dealer: NORDKYST.DealerName, cars: 2 },
      { dealer: FJORDBY.DealerName, cars: 1 },
    ]);
  });
});
