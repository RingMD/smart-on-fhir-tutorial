(function (window) {

  const { createApp, ref } = Vue

  function setup () {
    let client
    const display = ref({})
    const error = ref(null)
    const isLoading = ref(true)
    const selectedSlot = ref(null)
    const slots = ref([])
    const appointments = ref([])

    FHIR.oauth2.ready().then(async smartClient => {
      client = smartClient

      try {
        console.log('Practitioner resource identity: ' + client.user.fhirUser)
        console.log('Patient resource identity: ' + client.getState('serverUrl') + '/Patient/' + client.patient.id)

        const observationQuery = getQuery([
          { key: 'patient', value: client.patient.id },
          { key: 'code', value: [
                                  'http://loinc.org|8302-2',
                                  'http://loinc.org|8462-4',
                                  'http://loinc.org|8480-6',
                                  'http://loinc.org|2085-9',
                                  'http://loinc.org|2089-1',
                                  'http://loinc.org|55284-4'
                                ].join(',') }
        ])
        const results = await Promise.all([
          client.patient.read(),
          client.request(`Observation?${observationQuery}`, {
            pageLimit: 0,
            flat: true
          }),
          readAppointments(client),
          readSlots(client)
        ])

        display.value = displayPatient(client, results[0], results[1])
        slots.value = results[2]
        appointments.value = results[3]
      } catch (ex) {
        error.value = ex
      } finally {
        isLoading.value = false
      }
    }).catch(ex => {
      isLoading.value = false
      error.value = ex
    })

    async function refreshAppointments () {
      appointments.value = await readAppointments(client)
    }

    async function scheduleVideoVisit () {
      const slot = selectedSlot.value

      if (!slot) {
        return window.alert('Slot is required!')
      }

      try {
        isLoading.value = true

        await client.request({
          url: 'Appointment',
          method: 'POST',
          headers: {
            'Content-Type': 'application/fhir+json'
          },
          body: JSON.stringify({
            resourceType: 'Appointment',
            status: 'booked',
            slot: [{ reference: `Slot/${slot.id}` }],
            participant: [{
              actor: {
                reference: `Patient/${client.patient.id}`,
                display: `${display.value.firstName} ${display.value.lastName}`
              },
              status: 'accepted'
            }]
          })
        })

        await refreshAppointments()
      } catch (ex) {
        error.value = ex
      } finally {
        isLoading.value = false
      }
    }

    async function cancelAppointment (appointment) {
      try {
        isLoading.value = true

        await client.request({
          url: `Appointment/${appointment.id}`,
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/fhir+json'
          },
          body: JSON.stringify([
            { op: 'replace', path: '/status', value: 'cancelled' },
            {
              op: 'add',
              path: '/cancelationReason',
              value: {
                coding: [
                  {
                    system: 'http://terminology.hl7.org/CodeSystem/appointment-cancellation-reason',
                    code: 'oth-err'
                  }
                ]
              }
            }
          ])
        })

        await refreshAppointments()
      } catch (ex) {
        error.value = ex
      } finally {
        isLoading.value = false
      }
    }

    return {
      display,
      error,
      isLoading,
      scheduleVideoVisit,
      selectedSlot,
      slots,
      appointments,
      cancelAppointment
    }
  }

  // http://docs.smarthealthit.org/client-js/fhirjs-equivalents
  function getQuery (params) {
    const query = new URLSearchParams()

    params.forEach(param => {
      query.append(param.key, param.value)
    })

    return query
  }

  async function readAppointments (client) {
    const now = new Date()
    const query = getQuery([
      { key: 'patient', value: client.patient.id },
      { key: 'date', value: `ge${now.toISOString()}` }
    ])

    return client.request(`Appointment/?${query}`, {
      flat: true
    })
  }

  async function readSlots (client) {
    const now = new Date()
    const later = new Date()
    later.setDate(now.getDate() + 30)
    const min = now.toISOString()
    const max = later.toISOString()
    // get from the sandbox test data - "Video Visit"
    // https://docs.google.com/document/d/10RnVyF1etl_17pyCyK96tyhUWRbrTyEcqpwzW-Z-Ybs/edit#heading=h.78lvm8ihmcyu
    // for production, service types must be provided by the implementation team
    const serviceType = 'https://fhir.cerner.com/ec2458f2-1e24-41c8-b71b-0e701af7583d/codeSet/14249|2572307911'
    const query = getQuery([
      { key: 'schedule.actor', value: client.user.fhirUser },
      { key: 'service-type', value: serviceType },
      { key: 'start', value: `ge${min}` },
      { key: 'start', value: `lt${max}` }
    ])
    const results = await client.request(`Slot/?${query}`, {
      flat: true
    })

    return results.map(slot => {
      const start = (new Date(slot.start)).toLocaleString()
      const end = (new Date(slot.end)).toLocaleString()

      return {
        label: `${start} - ${end}`,
        value: slot
      }
    })
  }

  function displayPatient (client, patient, observations) {
    const byCodes = client.byCodes(observations, 'code')
    const display = {
      firstName: '-',
      lastName: '-',
      gender: patient.gender,
      birthDate: patient.birthDate,
      height: getQuantityValueAndUnit(byCodes('8302-2')[0]),
      systolicbp: getBloodPressureValue(byCodes('55284-4'),'8480-6'),
      diastolicbp: getBloodPressureValue(byCodes('55284-4'),'8462-4'),
      hdl: getQuantityValueAndUnit(byCodes('2085-9')[0]),
      ldl: getQuantityValueAndUnit(byCodes('2089-1')[0])
    }

    const name = patient.name[0]

    if (name) {
      display.firstName = name.given.join(' ')

      // https://github.com/cerner/smart-on-fhir-tutorial/pull/213
      if (Array.isArray(name.family)) {
        display.lastName = name.family.join(' ')
      } else {
        display.lastName = name.family
      }
    }

    return display
  }

  function getBloodPressureValue(BPObservations, typeOfPressure) {
    var formattedBPObservations = [];
    BPObservations.forEach(function(observation){
      var BP = observation.component.find(function(component){
        return component.code.coding.find(function(coding) {
          return coding.code == typeOfPressure;
        });
      });
      if (BP) {
        observation.valueQuantity = BP.valueQuantity;
        formattedBPObservations.push(observation);
      }
    });

    return getQuantityValueAndUnit(formattedBPObservations[0]);
  }

  function getQuantityValueAndUnit(ob) {
    if (typeof ob != 'undefined' &&
        typeof ob.valueQuantity != 'undefined' &&
        typeof ob.valueQuantity.value != 'undefined' &&
        typeof ob.valueQuantity.unit != 'undefined') {
          return ob.valueQuantity.value + ' ' + ob.valueQuantity.unit;
    } else {
      return '-';
    }
  }

  window.rmd = {
    init () {
      createApp({ setup }).mount('#app')
    }
  }

})(window);
