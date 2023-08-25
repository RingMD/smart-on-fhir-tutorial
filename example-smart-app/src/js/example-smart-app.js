(function (window) {

  const { createApp, computed, ref } = Vue

  function setup () {
    let client
    const user = ref({})
    const display = ref({})
    const error = ref(null)
    const isLoading = ref(true)
    const selectedSlot = ref(null)
    const slots = ref([])
    const appointments = ref([])

    const userEmail = computed(() => getEmail(user.value) || '')
    const userFullName = computed(() => {
      if (!user.value.name) {
        return ''
      }

      const { firstName, lastName } = getNames(user.value)

      return [firstName, lastName].join(' ')
    })
    const patientEmail = computed(() => display.value.email)
    const patientFullName = computed(() => [display.value.firstName, display.value.lastName].join(' '))

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
          client.user.read(),
          client.patient.read(),
          client.request(`Observation?${observationQuery}`, {
            pageLimit: 0,
            flat: true
          }),
          readAppointments(client),
          readSlots(client)
        ])

        user.value = results[0]
        display.value = displayPatient(client, results[1], results[2])
        appointments.value = results[3]
        slots.value = results[4]
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
      if (!userEmail.value || !patientEmail.value) {
        return window.alert('Need a primary email address for both user and patient!')
      }

      const slot = selectedSlot.value

      if (!slot) {
        return window.alert('Slot is required!')
      }

      try {
        isLoading.value = true

        const appointment = await client.request({
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
                display: patientFullName.value
              },
              status: 'accepted'
            }]
          })
        })

        const consultation = await createConsultation(slot)

        await patchAppointment(appointment, [
          { op: 'add', path: '/contained/0/telecom/0/value', value: consultation.receiver_join_url },
          { op: 'add', path: '/contained/1/telecom/0/value', value: consultation.caller_join_url },
          { op: 'add', path: '/contained/0/telecom/0/period/start', value: slot.start },
          { op: 'add', path: '/contained/0/telecom/0/period/end', value: slot.end }
        ])

        await refreshAppointments()
      } catch (ex) {
        error.value = ex
      } finally {
        isLoading.value = false
      }
    }

    async function createConsultation (slot) {
      const apiKey = 'jJxaxr-jVzMomxsvBEAw4hXXRtRmr1N654xgsu4HToEEmaDbx1_p9izgVMBeTEm3'
      const serverUrl = client.getState('serverUrl')
      const response = await axios.post(`https://demo-app.ringmd.com/api/partners/v1/consultations`, {
        caller: {
          username: `${serverUrl}/Patient/${client.patient.id}`,
          email: patientEmail.value,
          role: 'patient',
          full_name: patientFullName.value
        },
        receiver: {
          username: `${serverUrl}/${client.user.fhirUser}`,
          email: userEmail.value,
          role: 'doctor',
          full_name: userFullName.value
        },
        // IMPORTANT: must disable email notifications for cerner sandbox because the email addresses are dummy
        // TODO: enable for actual clients
        email_notifications: false,
        scheduled_at: slot.start
      })

      return response.data
    }

    async function cancelAppointment (appointment) {
      try {
        isLoading.value = true

        await patchAppointment(appointment, [
          { op: 'replace', path: '/status', value: 'cancelled' }
        ])

        await refreshAppointments()
      } catch (ex) {
        error.value = ex
      } finally {
        isLoading.value = false
      }
    }

    function patchAppointment (appointment, body) {
      return client.request({
        url: `Appointment/${appointment.id}`,
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json-patch+json',
          'If-Match': `W/"${appointment.meta.versionId}"`
        },
        body: JSON.stringify(body)
      })
    }

    return {
      userFullName,
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
      { key: 'date', value: `ge${now.toISOString()}` },
      { key: 'status', value: 'booked' }
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
      email: getEmail(patient),
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

    const { firstName, lastName } = getNames(patient)

    display.firstName = firstName
    display.lastName = lastName

    return display
  }

  function getNames (resource) {
    const name = resource?.name?.[0]

    if (!name) {
      return {}
    }

    const firstName = name.given.join(' ')
    // https://github.com/cerner/smart-on-fhir-tutorial/pull/213
    const lastName = Array.isArray(name.family) ? name.family.join(' ') : name.family

    return { firstName, lastName }
  }

  function getEmail (resource) {
    // the emails are sorted by rank, so just try to get the first
    const email = resource?.telecom?.some(tel => tel.system === 'email')

    return email?.value
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
